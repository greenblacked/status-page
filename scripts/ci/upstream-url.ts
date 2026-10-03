/**
 * The URL a test proxy fetches for a request line, or null when the line is not an origin-relative path.
 *
 * The e2e font-cache proxy forwards what a browser asks for to the preview server. The host of that request must
 * never come from the request: an absolute-form request line ("GET http://evil.example/ HTTP/1.1") or a
 * protocol-relative one ("//evil.example/") would otherwise turn the proxy into a request forger. So only a path that
 * starts with a single "/" is accepted, with no backslash (which URL parsers read as a "/"), no whitespace and no
 * control character, and the upstream URL is the fixed origin followed by that path.
 */
export function upstreamUrl(origin: string, requestUrl: string): string | null {
  if (!requestUrl.startsWith("/") || requestUrl.startsWith("//")) return null;
  for (const char of requestUrl) {
    const code = char.charCodeAt(0);
    if (char === "\\" || code <= 0x20 || code === 0x7f) return null;
  }
  const url = `${origin}${requestUrl}`;
  // Belt and braces: whatever the path held, the URL must still point at the origin it was built on.
  return new URL(url).origin === new URL(origin).origin ? url : null;
}
