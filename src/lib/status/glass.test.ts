import { describe, expect, it } from "vitest";
import {
  type AttributeTarget,
  applyReduceGlass,
  parseReduceGlassPreference,
  REDUCE_GLASS_ATTRIBUTE,
  REDUCE_GLASS_BOOT_SCRIPT,
  REDUCE_GLASS_STORAGE_KEY,
  serializeReduceGlassPreference,
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
