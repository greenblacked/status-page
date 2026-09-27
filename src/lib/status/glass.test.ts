import { describe, expect, it } from "vitest";
import {
  type AttributeTarget,
  applyReduceGlass,
  parseReduceGlassPreference,
  REDUCE_GLASS_ATTRIBUTE,
  REDUCE_GLASS_BOOT_SCRIPT,
  REDUCE_GLASS_STORAGE_KEY,
  readReduceGlass,
  reduceGlassFromStorageEvent,
  serializeReduceGlassPreference,
  writeReduceGlass,
} from "./glass";

function fakeRoot(): AttributeTarget & { attributes: Map<string, string> } {
  const attributes = new Map<string, string>();
  return {
    attributes,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  };
}

describe("reduce glass preference", () => {
  it("defaults to off and round-trips", () => {
    expect(parseReduceGlassPreference(null)).toBe(false);
    expect(parseReduceGlassPreference("garbage")).toBe(false);
    expect(parseReduceGlassPreference(serializeReduceGlassPreference(true))).toBe(true);
    expect(parseReduceGlassPreference(serializeReduceGlassPreference(false))).toBe(false);
  });

  it("sets and clears the attribute the CSS answers to", () => {
    const root = fakeRoot();
    applyReduceGlass(root, true);
    expect(root.attributes.get(REDUCE_GLASS_ATTRIBUTE)).toBe("true");
    applyReduceGlass(root, false);
    expect(root.attributes.has(REDUCE_GLASS_ATTRIBUTE)).toBe(false);
  });
});

describe("reduce glass boot script", () => {
  function run(stored: string | null, storage: "ok" | "throws" = "ok") {
    const root = fakeRoot();
    const localStorage = {
      getItem: (key: string) => {
        if (storage === "throws") throw new Error("storage refused");
        return key === REDUCE_GLASS_STORAGE_KEY ? stored : null;
      },
    };
    new Function("localStorage", "document", REDUCE_GLASS_BOOT_SCRIPT)(localStorage, { documentElement: root });
    return root.attributes.get(REDUCE_GLASS_ATTRIBUTE);
  }

  it("applies a stored choice before the page paints", () => {
    expect(run("on")).toBe("true");
    expect(run("off")).toBeUndefined();
    expect(run(null)).toBeUndefined();
  });

  it("leaves the page alone when storage is refused", () => {
    expect(run("on", "throws")).toBeUndefined();
  });
});

describe("reduce glass storage", () => {
  function memory(initial: Record<string, string> = {}) {
    const items = new Map(Object.entries(initial));
    return {
      items,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };
  }
  const refused = () => {
    throw new Error("storage refused");
  };

  it("reads and writes the stored choice", () => {
    const store = memory();
    expect(readReduceGlass(() => store)).toBe(false);
    writeReduceGlass(() => store, true);
    expect(store.items.get(REDUCE_GLASS_STORAGE_KEY)).toBe("on");
    expect(readReduceGlass(() => store)).toBe(true);
    writeReduceGlass(() => store, false);
    expect(readReduceGlass(() => store)).toBe(false);
  });

  it("falls back to off when storage is refused, and keeps going", () => {
    expect(readReduceGlass(refused)).toBe(false);
    expect(() => writeReduceGlass(refused, true)).not.toThrow();
  });

  it("follows other tabs, and a cleared storage puts the default back", () => {
    expect(reduceGlassFromStorageEvent({ key: REDUCE_GLASS_STORAGE_KEY, newValue: "on" })).toBe(true);
    expect(reduceGlassFromStorageEvent({ key: REDUCE_GLASS_STORAGE_KEY, newValue: "off" })).toBe(false);
    expect(reduceGlassFromStorageEvent({ key: REDUCE_GLASS_STORAGE_KEY, newValue: null })).toBe(false);
    expect(reduceGlassFromStorageEvent({ key: null, newValue: null })).toBe(false);
    expect(reduceGlassFromStorageEvent({ key: "status-bar:starred", newValue: "[]" })).toBeNull();
  });
});
