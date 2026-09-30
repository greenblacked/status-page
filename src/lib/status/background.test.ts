import { describe, expect, it } from "vitest";
import {
  APPEARANCE_BOOT_SCRIPT,
  applyBackground,
  BACKGROUND_ATTRIBUTE,
  BACKGROUND_STORAGE_KEY,
  BACKGROUNDS,
  backgroundFromStorageEvent,
  parseBackgroundPreference,
  readBackground,
  serializeBackgroundPreference,
  writeBackground,
} from "./background";
import { type AttributeTarget, REDUCE_GLASS_ATTRIBUTE, REDUCE_GLASS_STORAGE_KEY } from "./glass";

function fakeRoot(): AttributeTarget & { attributes: Map<string, string> } {
  const attributes = new Map<string, string>();
  return {
    attributes,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  };
}

describe("background preference", () => {
  it("is Quiet unless the browser chose otherwise, and round-trips every value", () => {
    expect(parseBackgroundPreference(null)).toBe("quiet");
    expect(parseBackgroundPreference("")).toBe("quiet");
    expect(parseBackgroundPreference("garbage")).toBe("quiet");
    expect(parseBackgroundPreference("FULL")).toBe("quiet");
    for (const value of BACKGROUNDS) {
      expect(parseBackgroundPreference(serializeBackgroundPreference(value))).toBe(value);
    }
  });

  it("reads and writes through the storage it is given", () => {
    const store = new Map<string, string>();
    const storage = () => ({
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    expect(readBackground(storage)).toBe("quiet");
    writeBackground(storage, "glass");
    expect(store.get(BACKGROUND_STORAGE_KEY)).toBe("glass");
    expect(readBackground(storage)).toBe("glass");
    writeBackground(storage, "full");
    expect(readBackground(storage)).toBe("full");
  });

  it("survives storage that throws", () => {
    const broken = () => {
      throw new Error("denied");
    };
    expect(readBackground(broken)).toBe("quiet");
    expect(() => writeBackground(broken, "full")).not.toThrow();
  });

  it("reads another tab's choice from a storage event, and ignores other keys", () => {
    expect(backgroundFromStorageEvent({ key: BACKGROUND_STORAGE_KEY, newValue: "full" })).toBe("full");
    expect(backgroundFromStorageEvent({ key: BACKGROUND_STORAGE_KEY, newValue: null })).toBe("quiet");
    expect(backgroundFromStorageEvent({ key: "something-else", newValue: "full" })).toBeNull();
    // localStorage.clear() puts the default back.
    expect(backgroundFromStorageEvent({ key: null, newValue: null })).toBe("quiet");
  });

  it("marks <html> for Glass and Full only; Quiet is no attribute at all", () => {
    const root = fakeRoot();
    applyBackground(root, "glass");
    expect(root.attributes.get(BACKGROUND_ATTRIBUTE)).toBe("glass");
    applyBackground(root, "full");
    expect(root.attributes.get(BACKGROUND_ATTRIBUTE)).toBe("full");
    applyBackground(root, "quiet");
    expect(root.attributes.has(BACKGROUND_ATTRIBUTE)).toBe(false);
  });
});

describe("appearance boot script", () => {
  /** Runs the script against stand-ins for localStorage and <html>. */
  function boot(stored: Record<string, string>, throwing = false) {
    const root = fakeRoot();
    const localStorage = {
      getItem: (key: string) => {
        if (throwing) throw new Error("denied");
        return stored[key] ?? null;
      },
    };
    new Function("localStorage", "document", APPEARANCE_BOOT_SCRIPT)(localStorage, { documentElement: root });
    return root.attributes;
  }

  it("sets nothing for a visitor with no choices", () => {
    expect(boot({}).size).toBe(0);
  });

  it("sets data-background for Glass and Full before paint", () => {
    expect(boot({ [BACKGROUND_STORAGE_KEY]: "glass" }).get(BACKGROUND_ATTRIBUTE)).toBe("glass");
    expect(boot({ [BACKGROUND_STORAGE_KEY]: "full" }).get(BACKGROUND_ATTRIBUTE)).toBe("full");
  });

  it("leaves Quiet and unreadable values as no attribute", () => {
    expect(boot({ [BACKGROUND_STORAGE_KEY]: "quiet" }).size).toBe(0);
    expect(boot({ [BACKGROUND_STORAGE_KEY]: "<script>" }).size).toBe(0);
  });

  it("still applies Reduce glass, and both together", () => {
    expect(boot({ [REDUCE_GLASS_STORAGE_KEY]: "on" }).get(REDUCE_GLASS_ATTRIBUTE)).toBe("true");
    const both = boot({ [REDUCE_GLASS_STORAGE_KEY]: "on", [BACKGROUND_STORAGE_KEY]: "full" });
    expect(both.get(REDUCE_GLASS_ATTRIBUTE)).toBe("true");
    expect(both.get(BACKGROUND_ATTRIBUTE)).toBe("full");
  });

  it("does not throw when storage does", () => {
    expect(boot({}, true).size).toBe(0);
  });
});
