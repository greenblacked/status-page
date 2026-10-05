import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyTheme,
  isNightHour,
  parseTheme,
  readStoredTheme,
  THEME_ATTRIBUTE,
  THEME_BOOT_SCRIPT,
  THEME_COLORS,
  THEME_STORAGE_KEY,
  type ThemeStorage,
  themeFor,
  themeStorageEventMatters,
  writeStoredTheme,
} from "./theme";

const memory = (initial: Record<string, string> = {}): ThemeStorage & { data: Map<string, string> } => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
};

const refusing: () => ThemeStorage = () => {
  throw new DOMException("denied", "SecurityError");
};

describe("themeFor, the rule", () => {
  it("is night from 20:00 to 06:00 and day from 06:00 to 20:00 when nothing is stored", () => {
    expect(themeFor(null, 5)).toBe("night");
    expect(themeFor(null, 6)).toBe("day");
    expect(themeFor(null, 19)).toBe("day");
    expect(themeFor(null, 20)).toBe("night");
    expect(themeFor(null, 0)).toBe("night");
    expect(themeFor(null, 12)).toBe("day");
    expect(themeFor(null, 23)).toBe("night");
  });

  it("changes at the hour, not before: 05:59 is still night, 19:59 still day", () => {
    // getHours() is the hour of 05:59 and of 19:59; the boundaries are the hours 6 and 20.
    expect(isNightHour(new Date("2026-10-05T05:59:00").getHours())).toBe(true);
    expect(isNightHour(new Date("2026-10-05T06:00:00").getHours())).toBe(false);
    expect(isNightHour(new Date("2026-10-05T19:59:00").getHours())).toBe(false);
    expect(isNightHour(new Date("2026-10-05T20:00:00").getHours())).toBe(true);
  });

  it("lets a stored choice win over the clock, both ways", () => {
    expect(themeFor("day", 23)).toBe("day");
    expect(themeFor("day", 3)).toBe("day");
    expect(themeFor("night", 12)).toBe("night");
    expect(themeFor("night", 7)).toBe("night");
  });

  it("treats anything else stored as no choice", () => {
    for (const junk of ["", "Night", "DAY", "dark", "light", "reactor", "1", "null", " night", undefined, 3, {}]) {
      expect(parseTheme(junk), String(junk)).toBeNull();
      expect(themeFor(junk, 12), String(junk)).toBe("day");
      expect(themeFor(junk, 22), String(junk)).toBe("night");
    }
  });

  it("falls to day for an hour that is not a number", () => {
    expect(themeFor(null, Number.NaN)).toBe("day");
  });
});

describe("the stored choice", () => {
  it("round-trips through the storage key", () => {
    const storage = memory();
    expect(readStoredTheme(() => storage)).toBeNull();
    expect(writeStoredTheme(() => storage, "night")).toBe(true);
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("night");
    expect(readStoredTheme(() => storage)).toBe("night");
    writeStoredTheme(() => storage, "day");
    expect(readStoredTheme(() => storage)).toBe("day");
  });

  it("reads junk as no choice", () => {
    expect(readStoredTheme(() => memory({ [THEME_STORAGE_KEY]: "purple" }))).toBeNull();
  });

  it("survives storage that throws, on the getter, the read and the write", () => {
    expect(readStoredTheme(refusing)).toBeNull();
    expect(writeStoredTheme(refusing, "night")).toBe(false);
    const throwing: ThemeStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(readStoredTheme(() => throwing)).toBeNull();
    expect(writeStoredTheme(() => throwing, "day")).toBe(false);
  });

  it("reacts to the storage events that can change it", () => {
    expect(themeStorageEventMatters({ key: THEME_STORAGE_KEY })).toBe(true);
    expect(themeStorageEventMatters({ key: null })).toBe(true);
    expect(themeStorageEventMatters({ key: "status-bar:background" })).toBe(false);
  });
});

describe("applyTheme", () => {
  it("writes data-theme and every theme-color meta", () => {
    const attributes = new Map<string, string>();
    const metas = [new Map<string, string>(), new Map<string, string>()];
    const doc = {
      documentElement: { setAttribute: (name: string, value: string) => void attributes.set(name, value) },
      querySelectorAll: (selector: string) => {
        expect(selector).toBe('meta[name="theme-color"]');
        return metas.map((meta) => ({ setAttribute: (name: string, value: string) => void meta.set(name, value) }));
      },
    };
    applyTheme(doc, "night");
    expect(attributes.get(THEME_ATTRIBUTE)).toBe("night");
    expect(metas.map((meta) => meta.get("content"))).toEqual([THEME_COLORS.night, THEME_COLORS.night]);
    applyTheme(doc, "day");
    expect(attributes.get(THEME_ATTRIBUTE)).toBe("day");
    expect(metas.map((meta) => meta.get("content"))).toEqual([THEME_COLORS.day, THEME_COLORS.day]);
  });
});

describe("the theme-color of each theme", () => {
  it("is the page background of that theme in the style sheet", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const bg = /--color-bg:\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/i.exec(css);
    expect(bg, "--color-bg in styles.css").not.toBeNull();
    expect(THEME_COLORS.day).toBe(bg?.[1]);
    expect(THEME_COLORS.night).toBe(bg?.[2]);
  });
});

/** Runs the boot script against stand-ins, as the browser would, and reports what it wrote. */
function boot(options: { storage: "refuse" | Record<string, string>; hour: number; metas?: number }) {
  const attributes = new Map<string, string>();
  const metas = Array.from({ length: options.metas ?? 2 }, () => new Map<string, string>());
  const stored = options.storage;
  const localStorage =
    stored === "refuse"
      ? {
          getItem: () => {
            throw new DOMException("denied", "SecurityError");
          },
        }
      : { getItem: (key: string) => stored[key] ?? null };
  const document = {
    documentElement: { setAttribute: (name: string, value: string) => void attributes.set(name, value) },
    querySelectorAll: () =>
      metas.map((meta) => ({ setAttribute: (name: string, value: string) => void meta.set(name, value) })),
  };
  class FakeDate {
    getHours() {
      return options.hour;
    }
  }
  new Function("localStorage", "document", "Date", THEME_BOOT_SCRIPT)(localStorage, document, FakeDate);
  return { theme: attributes.get(THEME_ATTRIBUTE), colors: metas.map((meta) => meta.get("content")) };
}

describe("THEME_BOOT_SCRIPT", () => {
  it("agrees with themeFor for every hour and every stored value", () => {
    for (const stored of [undefined, "day", "night", "junk"]) {
      for (let hour = 0; hour < 24; hour++) {
        const result = boot({ storage: stored === undefined ? {} : { [THEME_STORAGE_KEY]: stored }, hour });
        const expected = themeFor(stored, hour);
        expect(result.theme, `${stored} at ${hour}`).toBe(expected);
        expect(result.colors, `${stored} at ${hour}`).toEqual([THEME_COLORS[expected], THEME_COLORS[expected]]);
      }
    }
  });

  it("falls back to the clock when storage cannot be read", () => {
    expect(boot({ storage: "refuse", hour: 21 }).theme).toBe("night");
    expect(boot({ storage: "refuse", hour: 10 }).theme).toBe("day");
  });

  it("still sets the attribute on a page with no theme-color meta", () => {
    expect(boot({ storage: {}, hour: 22, metas: 0 })).toEqual({ theme: "night", colors: [] });
  });

  it("is one line with no raw newline, so it sits in a script tag whole", () => {
    expect(THEME_BOOT_SCRIPT).not.toContain("\n");
    expect(THEME_BOOT_SCRIPT).not.toContain("</script");
  });
});
