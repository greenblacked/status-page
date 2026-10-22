// Conditional GET for the public endpoints. A feed reader, a badge service or
// a dashboard that polls every minute sends back the ETag it was given and
// gets an empty 304 while the board has not changed, instead of the whole body.

/** Hex of the first 8 bytes of the body's SHA-256: plenty to tell two board snapshots apart. */
async function digest(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(hash.subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The opaque part of an entity tag, so W/"x" and "x" compare equal (the weak comparison of RFC 9110 13.1.2). */
function opaque(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
}

function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const wanted = opaque(etag);
  return ifNoneMatch.split(",").some((tag) => opaque(tag) === wanted);
}

/**
 * A 200 answer to GET or HEAD with a weak ETag over its body, or 304 with
 * no body when the request's If-None-Match already names it. The body is a
 * pure function of the board snapshot, so it is weak (the Node server may
 * still compress it) and the same snapshot always gives the same tag. Any
 * other status or method passes through untouched.
 */
export async function withValidator(request: Request, response: Response): Promise<Response> {
  if (response.status !== 200 || (request.method !== "GET" && request.method !== "HEAD")) return response;

  const text = await response.text();
  const etag = `W/"${await digest(text)}"`;
  const headers = new Headers(response.headers);
  headers.set("ETag", etag);

  if (matches(request.headers.get("If-None-Match"), etag)) {
    headers.delete("Content-Length");
    headers.delete("Content-Type");
    return new Response(null, { status: 304, headers });
  }
  return new Response(text, { status: 200, headers });
}
