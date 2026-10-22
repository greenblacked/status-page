import { describe, expect, it } from "vitest";
import { createValidatorCache, type ValidatorEntry } from "./validator-cache";

const entry = (byteLength: number, etag = '"x"'): ValidatorEntry => ({
  etag,
  bytes: new ArrayBuffer(byteLength),
  contentType: "application/json",
});

describe("createValidatorCache", () => {
  it("stores and returns an entry, and forgets it on delete and clear", () => {
    const cache = createValidatorCache();
    expect(cache.set("a", entry(10, 'W/"a"'))).toBe(true);
    expect(cache.get("a")?.etag).toBe('W/"a"');
    expect(cache.size).toBe(1);
    expect(cache.totalBytes).toBe(10);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.totalBytes).toBe(0);
    cache.set("b", entry(5));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.totalBytes).toBe(0);
  });

  it("replaces an entry without counting the old one's bytes", () => {
    const cache = createValidatorCache();
    cache.set("a", entry(10, '"1"'));
    cache.set("a", entry(30, '"2"'));
    expect(cache.get("a")?.etag).toBe('"2"');
    expect(cache.size).toBe(1);
    expect(cache.totalBytes).toBe(30);
  });

  it("evicts the least recently used entry past the entry count", () => {
    const cache = createValidatorCache({ maxEntries: 2 });
    cache.set("a", entry(1));
    cache.set("b", entry(1));
    // Reading "a" makes "b" the oldest.
    cache.get("a");
    cache.set("c", entry(1));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it("evicts the least recently used entries past the total size", () => {
    const cache = createValidatorCache({ maxEntryBytes: 100, maxTotalBytes: 250 });
    cache.set("a", entry(100));
    cache.set("b", entry(100));
    cache.set("c", entry(100));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(2);
    expect(cache.totalBytes).toBe(200);
  });

  it("refuses an entry over the per-entry size, and drops the one it would have replaced", () => {
    const cache = createValidatorCache({ maxEntryBytes: 100 });
    cache.set("a", entry(100));
    expect(cache.set("a", entry(101))).toBe(false);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.totalBytes).toBe(0);
  });

  it("defaults to 512 KiB an entry", () => {
    const cache = createValidatorCache();
    expect(cache.set("a", entry(512 * 1024))).toBe(true);
    expect(cache.set("b", entry(512 * 1024 + 1))).toBe(false);
  });
});
