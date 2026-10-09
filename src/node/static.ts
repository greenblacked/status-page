// What the Node server (serve.ts) needs to hand out the built client files:
// the cache rule per URL, the content type, which compression a request
// accepts, and an in-memory index of dist/client. Plain Node, no dependency,
// and nothing here imports the app: it also runs as it is, through Node's type
// stripping, in the container image (hence the .ts extensions on imports).

import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

/**
 * Everything under /assets/ is built by Vite with a content hash in its name,
 * so a changed file gets a new URL and an old one never changes. The same rule
 * as public/_headers, which only Cloudflare reads.
 */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Files that keep their name between releases (icons, the manifest, the share image): an hour, then revalidate. */
export const SHORT_CACHE_CONTROL = "public, max-age=3600";

/** Static files nobody should be served from dist/client: Cloudflare's header rules are not content. */
const NEVER_SERVED = new Set(["/_headers"]);

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** The Cache-Control of a static file by its URL path. */
export function cacheControlFor(urlPath: string): string {
  return urlPath.startsWith("/assets/") ? IMMUTABLE_CACHE_CONTROL : SHORT_CACHE_CONTROL;
}

/**
 * Whether a body of this type shrinks enough to be worth compressing. Images
 * and fonts (woff2) are compressed already; SVG, text and JSON are not.
 */
export function isCompressible(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type.startsWith("text/") ||
    type === "image/svg+xml" ||
    type === "application/json" ||
    type === "application/javascript" ||
    type === "application/xml" ||
    type === "application/manifest+json" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

export type Encoding = "br" | "gzip";

/**
 * The best encoding an Accept-Encoding header allows: Brotli, then gzip, or
 * null for none. Honours q-values (`br;q=0`, `*;q=0.5`) and ignores the rest.
 */
export function negotiateEncoding(acceptEncoding: string | null | undefined): Encoding | null {
  if (!acceptEncoding) return null;
  const weights = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param);
      if (match) q = Number(match[1]);
    }
    weights.set(name.trim(), Number.isFinite(q) ? q : 0);
  }
  const weight = (name: string) => weights.get(name) ?? weights.get("*") ?? 0;
  const brotli = weight("br");
  const gz = weight("gzip");
  if (brotli > 0 && brotli >= gz) return "br";
  if (gz > 0) return "gzip";
  return null;
}

/** Below this a compressed body saves less than the headers cost. */
export const MIN_COMPRESS_BYTES = 1024;

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** One file of dist/client, held in memory with its compressed copies made on first use. */
export interface StaticFile {
  /** The URL path, decoded: "/assets/index-abc.js". */
  path: string;
  body: Buffer;
  contentType: string;
  cacheControl: string;
  /** A weak validator from the bytes, so a new build of the same name is never answered 304. */
  etag: string;
  /** Whether a request that accepts an encoding can get a smaller copy (text of a useful size). */
  compressible: boolean;
  /** The compressed body for an encoding, or null when it is not worth it (an image, a tiny file). */
  encoded(encoding: Encoding): Promise<Buffer | null>;
}

function weakEtag(body: Buffer): string {
  // FNV-1a over the bytes: not security, only "did this file change".
  let hash = 0x811c9dc5;
  for (const byte of body) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `W/"${body.length.toString(16)}-${hash.toString(16)}"`;
}

function makeFile(path: string, body: Buffer): StaticFile {
  const contentType = contentTypeFor(path);
  const compressible = isCompressible(contentType) && body.length >= MIN_COMPRESS_BYTES;
  const cache = new Map<Encoding, Promise<Buffer | null>>();
  return {
    path,
    body,
    contentType,
    cacheControl: cacheControlFor(path),
    etag: weakEtag(body),
    compressible,
    encoded(encoding) {
      if (!compressible) return Promise.resolve(null);
      let pending = cache.get(encoding);
      if (!pending) {
        pending =
          encoding === "br"
            ? brotliAsync(body, {
                params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: body.length },
              })
            : gzipAsync(body, { level: 9 });
        cache.set(encoding, pending);
      }
      return pending;
    },
  };
}

/** The files of a directory tree by URL path. Only regular files; nothing outside the tree can be named. */
export type StaticIndex = ReadonlyMap<string, StaticFile>;

/**
 * Reads every regular file under `root` once. Serving from a map keyed by the
 * URL path means a request can only ever name a file that was indexed here, so
 * there is no path to normalise and no way to climb out of the directory.
 */
export async function indexStaticFiles(root: string): Promise<StaticIndex> {
  const files = new Map<string, StaticFile>();
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const urlPath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), urlPath);
      } else if (entry.isFile() && !NEVER_SERVED.has(urlPath)) {
        files.set(urlPath, makeFile(urlPath, await readFile(join(dir, entry.name))));
      }
    }
  }
  await walk(root, "");
  return files;
}

/** The URL path of a request, percent-decoded, or null when it is not valid. */
export function decodePathname(pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded.includes("\0") ? null : decoded;
  } catch {
    return null;
  }
}

/** Whether an If-None-Match header matches a weak ETag (or is `*`). */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const strip = (value: string) => value.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((candidate) => strip(candidate) === strip(etag));
}
