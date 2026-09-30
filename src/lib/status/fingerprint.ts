/**
 * FNV-1a: a short, stable, non-cryptographic fingerprint of some text, as 8
 * hex digits. The same text always gives the same value, in every process and
 * on every run, so it is safe to build an id from content where the vendor
 * gives none (unlike a random UUID, which would change every sweep).
 */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
