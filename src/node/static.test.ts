import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cacheControlFor,
  contentTypeFor,
  decodePathname,
  etagMatches,
  IMMUTABLE_CACHE_CONTROL,
  indexStaticFiles,
  isCompressible,
  negotiateEncoding,
  SHORT_CACHE_CONTROL,
} from "./static.ts";

describe("cacheControlFor", () => {
  it("caches hashed build output for a year and everything else for an hour", () => {
    expect(cacheControlFor("/assets/index-abc123.js")).toBe("public, max-age=31536000, immutable");
    expect(cacheControlFor("/assets/inter-var-B5rhjub6.woff2")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(cacheControlFor("/favicon.svg")).toBe(SHORT_CACHE_CONTROL);
    expect(cacheControlFor("/manifest.webmanifest")).toBe("public, max-age=3600");
    // A file that merely has "assets" in its name is not under /assets/.
    expect(cacheControlFor("/assetsx/a.js")).toBe(SHORT_CACHE_CONTROL);
  });
});

describe("contentTypeFor", () => {
  it("names the types the build emits, with a charset on text", () => {
    expect(contentTypeFor("/assets/a.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("/assets/a.CSS")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("/manifest.webmanifest")).toBe("application/manifest+json; charset=utf-8");
    expect(contentTypeFor("/favicon.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("/assets/f.woff2")).toBe("font/woff2");
    expect(contentTypeFor("/og.jpg")).toBe("image/jpeg");
    expect(contentTypeFor("/mystery.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("/no-extension")).toBe("application/octet-stream");
  });
});

describe("isCompressible", () => {
  it("compresses text, JSON, XML and SVG but not images or fonts", () => {
    for (const type of [
      "text/html; charset=utf-8",
      "text/css",
      "application/json",
      "application/atom+xml",
      "application/manifest+json; charset=utf-8",
      "image/svg+xml",
    ]) {
      expect(isCompressible(type), type).toBe(true);
    }
    for (const type of ["image/png", "image/jpeg", "font/woff2", "application/octet-stream", "", null, undefined]) {
      expect(isCompressible(type), String(type)).toBe(false);
    }
  });
});

describe("negotiateEncoding", () => {
  it("prefers Brotli, then gzip, and none when neither is accepted", () => {
    expect(negotiateEncoding("gzip, deflate, br")).toBe("br");
    expect(negotiateEncoding("gzip")).toBe("gzip");
    expect(negotiateEncoding("deflate")).toBeNull();
    expect(negotiateEncoding("identity")).toBeNull();
    expect(negotiateEncoding("")).toBeNull();
    expect(negotiateEncoding(undefined)).toBeNull();
  });

  it("honours q-values, including a refusal", () => {
    expect(negotiateEncoding("br;q=0, gzip")).toBe("gzip");
    expect(negotiateEncoding("gzip;q=1.0, br;q=0.5")).toBe("gzip");
    expect(negotiateEncoding("br;q=0.8, gzip;q=0.8")).toBe("br");
    expect(negotiateEncoding("gzip;q=0, br;q=0")).toBeNull();
    expect(negotiateEncoding("*")).toBe("br");
    expect(negotiateEncoding("*;q=0, gzip")).toBe("gzip");
    expect(negotiateEncoding("BR")).toBe("br");
  });
});

describe("decodePathname", () => {
  it("decodes percent escapes and rejects what cannot be a path", () => {
    expect(decodePathname("/assets/a%20b.js")).toBe("/assets/a b.js");
    expect(decodePathname("/%E0%A4%A")).toBeNull();
    expect(decodePathname("/a%00b")).toBeNull();
  });
});

describe("etagMatches", () => {
  it("compares weakly, over a list, and accepts *", () => {
    expect(etagMatches('W/"a-1"', 'W/"a-1"')).toBe(true);
    expect(etagMatches('"a-1"', 'W/"a-1"')).toBe(true);
    expect(etagMatches('"x", W/"a-1"', 'W/"a-1"')).toBe(true);
    expect(etagMatches("*", 'W/"a-1"')).toBe(true);
    expect(etagMatches('W/"b-2"', 'W/"a-1"')).toBe(false);
    expect(etagMatches(undefined, 'W/"a-1"')).toBe(false);
    expect(etagMatches("", 'W/"a-1"')).toBe(false);
  });
});

describe("indexStaticFiles", () => {
  let root: string;
  const big = `${"body { color: red; }\n".repeat(200)}`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "static-index-"));
    await mkdir(join(root, "assets"));
    await mkdir(join(root, "fonts"));
    await writeFile(join(root, "assets", "app-abc.css"), big);
    await writeFile(join(root, "assets", "tiny.js"), "x=1");
    await writeFile(join(root, "fonts", "OFL.txt"), "licence");
    await writeFile(join(root, "og.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    await writeFile(join(root, "_headers"), "/assets/*\n  Cache-Control: x\n");
    await symlink("/etc/hostname", join(root, "link"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("indexes every regular file by URL path, and leaves out _headers and symlinks", async () => {
    const index = await indexStaticFiles(root);
    expect([...index.keys()].sort()).toEqual(["/assets/app-abc.css", "/assets/tiny.js", "/fonts/OFL.txt", "/og.jpg"]);
  });

  it("gives each file its type, cache rule and validator", async () => {
    const index = await indexStaticFiles(root);
    const css = index.get("/assets/app-abc.css");
    expect(css?.contentType).toBe("text/css; charset=utf-8");
    expect(css?.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(css?.etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(index.get("/og.jpg")?.cacheControl).toBe(SHORT_CACHE_CONTROL);
    expect(index.get("/og.jpg")?.etag).not.toBe(css?.etag);
  });

  it("compresses text of a useful size, once, and never an image or a tiny file", async () => {
    const index = await indexStaticFiles(root);
    const css = index.get("/assets/app-abc.css");
    expect(css?.compressible).toBe(true);
    const br = await css?.encoded("br");
    const gz = await css?.encoded("gzip");
    expect(br && brotliDecompressSync(br).toString()).toBe(big);
    expect(gz && gunzipSync(gz).toString()).toBe(big);
    expect(br && br.length < big.length).toBe(true);
    expect(await css?.encoded("br")).toBe(br);
    expect(await index.get("/assets/tiny.js")?.encoded("br")).toBeNull();
    expect(await index.get("/og.jpg")?.encoded("gzip")).toBeNull();
    expect(index.get("/og.jpg")?.compressible).toBe(false);
  });
});
