import { AsyncLocalStorage } from "node:async_hooks";

const USER_AGENT = "StatusBar/1.0 (status board; official sources only)";
const DEFAULT_TIMEOUT_MS = 9000;

/**
 * The most a single vendor response may be. The largest official payload
 * the collectors read (AWS's current events, Steam's SDR config) is a few
 * hundred KiB; 4 MiB leaves an order of magnitude of headroom while keeping
 * a runaway or hostile response from holding a Worker isolate's 128 MB, or
 * the CPU to decode and parse it, for the rest of a sweep.
 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

// Bytes read by every fetch made inside meterBytes(), so each collector's
// log line can say how much it downloaded without threading a counter
// through every collector and helper. AsyncLocalStorage is the same
// mechanism cloudflare-context.ts relies on (nodejs_compat on Workers).
const byteMeter = new AsyncLocalStorage<{ bytes: number }>();

/** Runs `fn`, counting the response bytes of every fetchText it makes. */
export function meterBytes<T>(fn: (meter: { readonly bytes: number }) => Promise<T>): Promise<T> {
  const meter = { bytes: 0 };
  return byteMeter.run(meter, () => fn(meter));
}

/** Bytes read so far inside the current meterBytes() call, or 0 outside one. */
export function meteredBytes(): number {
  return byteMeter.getStore()?.bytes ?? 0;
}

export class SourceError extends Error {
  // Declared as a field rather than a constructor parameter property:
  // parameter properties are not erasable, so they break Node's type
  // stripping and TypeScript's own `erasableSyntaxOnly`.
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "SourceError";
    this.status = status;
  }
}

// The vendor answered, but not with data the collector can use: an empty
// feed, missing items, or no channel that parses. Unlike a transport failure,
// this usually means the payload changed and the collector needs a fix.
export class PayloadError extends SourceError {
  constructor(message: string) {
    super(message);
    this.name = "PayloadError";
  }
}

// Failure messages end up on a card, so name the vendor host rather than the
// full URL: a long path cannot fit a card, and the card already links the
// vendor's page. `source-health` logs carry the same text.
function sourceHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function tooLarge(url: string, maxBytes: number): PayloadError {
  return new PayloadError(`Response from ${sourceHost(url)} is larger than ${Math.round(maxBytes / 1024 / 1024)} MiB`);
}

/**
 * The body, read chunk by chunk so an oversized response is dropped as soon
 * as it crosses `maxBytes` instead of after it has all been buffered. A
 * declared Content-Length over the cap is refused before reading anything;
 * a missing or false one is caught by the running count. PayloadError, not
 * a plain SourceError: the vendor answered, just not with something a
 * collector can use, which is what "parser" failures mean on the card.
 */
export async function readBodyCapped(
  response: Response,
  url: string,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<ArrayBuffer> {
  const meter = byteMeter.getStore();
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge(url, maxBytes);
  }
  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (meter) meter.bytes += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(url, maxBytes);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Where a request may be redirected, other than to the host it asked: the
 * hosts a vendor itself spreads one data set over. Everything else is
 * refused, a sibling subdomain included, because a registrable domain can
 * also host other people's content (`sites.google.com`, any `*.amazon.com`
 * bucket or `*.statuspage.io` tenant). Keyed by the requested host; add an
 * entry only for a redirect a collector's real URL has been seen to make.
 */
const REDIRECT_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "upgrade.mikrotik.com": ["download.mikrotik.com"],
  "download.mikrotik.com": ["upgrade.mikrotik.com"],
};

/**
 * Whether a redirect to `target` stays with the vendor that was asked: https,
 * no credentials, and exactly the requested host or one REDIRECT_ALLOWED
 * lists for it. A redirect to anything else is not followed, so a hijacked or
 * misconfigured vendor endpoint cannot send the Worker to an arbitrary host.
 */
function staysWithVendor(requested: URL, target: URL): boolean {
  if (target.protocol !== "https:" || target.username || target.password) return false;
  return (
    target.hostname === requested.hostname || (REDIRECT_ALLOWED[requested.hostname] ?? []).includes(target.hostname)
  );
}

// Where a refused redirect went, for the error: the host (never the path or
// query, which are the vendor's to make long), with the scheme when that is
// what was wrong.
function describeTarget(target: URL | undefined): string {
  if (!target) return "an unreadable location";
  return target.protocol === "https:" ? target.host : `${target.protocol}//${target.host}`;
}

// fetch with redirects followed by hand, at most MAX_REDIRECTS and only
// within staysWithVendor. `redirect: "manual"` hands back the 3xx response
// and its Location header both on Workers and in Node.
async function fetchVendor(url: string, init: RequestInit): Promise<Response> {
  const requested = new URL(url);
  let current = requested;
  for (let hops = 0; ; hops += 1) {
    const response = await fetch(current.href, { ...init, redirect: "manual" });
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (location === null) return response;
    await response.body?.cancel().catch(() => {});
    let target: URL | undefined;
    try {
      target = new URL(location, current);
    } catch {
      target = undefined;
    }
    if (!target || !staysWithVendor(requested, target)) {
      throw new SourceError(
        `Request to ${sourceHost(url)} redirected to ${describeTarget(target)}, off the vendor's host`,
      );
    }
    if (hops >= MAX_REDIRECTS) throw new SourceError(`Too many redirects from ${sourceHost(url)}`);
    current = target;
  }
}

export async function fetchText(
  url: string,
  init: RequestInit & { timeoutMs?: number; binary?: boolean } = {},
): Promise<{ body: string; bytes: ArrayBuffer; contentType: string; status: number }> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, binary, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchVendor(url, {
      ...rest,
      signal: controller.signal,
      headers: {
        Accept: "application/json, application/xml, text/xml, text/javascript, */*",
        "User-Agent": USER_AGENT,
        ...(rest.headers ?? {}),
      },
      cache: "no-store",
    });
    if (!response.ok) {
      // Nothing in an error page is used, so it is never downloaded.
      await response.body?.cancel().catch(() => {});
      throw new SourceError(`${response.status} ${response.statusText} from ${sourceHost(url)}`, response.status);
    }
    // Still under the timeout above: a vendor trickling a body in slowly
    // is aborted like one that never answers.
    const bytes = await readBodyCapped(response, url);
    const contentType = response.headers.get("content-type") ?? "";
    let body: string;
    if (binary) {
      const bom = new Uint8Array(bytes.slice(0, 2));
      if (bom[0] === 0xfe && bom[1] === 0xff) {
        body = new TextDecoder("utf-16be").decode(bytes.slice(2));
      } else if (bom[0] === 0xff && bom[1] === 0xfe) {
        body = new TextDecoder("utf-16le").decode(bytes.slice(2));
      } else {
        body = new TextDecoder("utf-16le").decode(bytes);
      }
    } else {
      body = new TextDecoder("utf-8").decode(bytes);
    }
    return { body, bytes, contentType, status: response.status };
  } catch (error) {
    if (error instanceof SourceError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new SourceError(`Timed out fetching ${sourceHost(url)}`);
    }
    throw new SourceError(error instanceof Error ? error.message : `Failed to fetch ${sourceHost(url)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number; binary?: boolean },
): Promise<T> {
  const { body } = await fetchText(url, init);
  const trimmed = body.replace(/^\uFEFF/, "").trim();
  const jsonPayload = unwrapJsonp(trimmed);
  return JSON.parse(jsonPayload) as T;
}

/**
 * The JSON inside a JSONP wrapper (`callback({...});`), or the payload
 * unchanged when it is not one. A linear scan, not a regex: the earlier
 * `^id\(([\s\S]*)\)\s*;?\s*$` backtracked quadratically on `f()` followed by
 * a long run of spaces and one more character, and the body is vendor input.
 * The wrapper is an identifier, then the first "(", then the last ")" with
 * only whitespace and an optional ";" after it.
 */
export function unwrapJsonp(payload: string): string {
  const open = payload.indexOf("(");
  const close = payload.lastIndexOf(")");
  if (open < 1 || close < open + 2) return payload;
  // Anchored and a single quantifier: it cannot backtrack against itself.
  if (!/^[A-Za-z_$][\w$]*$/.test(payload.slice(0, open))) return payload;
  // trim() strips exactly the characters `\s` matches.
  const rest = payload.slice(close + 1).trim();
  if (rest !== "" && rest !== ";") return payload;
  return payload.slice(open + 1, close);
}
