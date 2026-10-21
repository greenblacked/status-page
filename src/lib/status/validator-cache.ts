/**
 * What a vendor said about a body it served, so the next request for the
 * same URL can ask "has it changed?" (If-None-Match / If-Modified-Since)
 * and, on a 304, use the body kept here instead of downloading it again.
 * Only the validators the vendor sent are kept.
 */
export type ValidatorEntry = {
  etag?: string;
  lastModified?: string;
  bytes: ArrayBuffer;
  contentType: string;
};

/** The largest body the vendor cache keeps by default. */
export const MAX_VALIDATED_BYTES = 512 * 1024;

type ValidatorCacheOptions = {
  // A larger body is not kept: revalidation pays off for the small, often
  // unchanged payloads, and a few large ones would crowd them out.
  maxEntryBytes?: number;
  // What all kept bodies may add up to, in an isolate's 128 MB.
  maxTotalBytes?: number;
  maxEntries?: number;
};

/** A least-recently-used map from URL to validators and body, bounded by count and by bytes. */
export function createValidatorCache({
  maxEntryBytes = MAX_VALIDATED_BYTES,
  maxTotalBytes = 4 * 1024 * 1024,
  maxEntries = 64,
}: ValidatorCacheOptions = {}) {
  // A Map iterates in insertion order, so re-inserting on use keeps the least recently used first.
  const entries = new Map<string, ValidatorEntry>();
  let totalBytes = 0;

  function remove(key: string): void {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    totalBytes -= entry.bytes.byteLength;
  }

  return {
    get(key: string): ValidatorEntry | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    /** Keeps `entry` for `key`, or drops what `key` had and returns false when the body is too large to keep. */
    set(key: string, entry: ValidatorEntry): boolean {
      remove(key);
      if (entry.bytes.byteLength > maxEntryBytes) return false;
      entries.set(key, entry);
      totalBytes += entry.bytes.byteLength;
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries && totalBytes <= maxTotalBytes) break;
        remove(oldest);
      }
      return entries.has(key);
    },
    delete: remove,
    clear(): void {
      entries.clear();
      totalBytes = 0;
    },
    get size(): number {
      return entries.size;
    },
    get totalBytes(): number {
      return totalBytes;
    },
  };
}

/** The validators of every vendor response fetchText read in full, shared by every sweep in the isolate. */
export const vendorValidators = createValidatorCache();

/** Forgets every stored validator; for tests. */
export function clearVendorValidators(): void {
  vendorValidators.clear();
}
