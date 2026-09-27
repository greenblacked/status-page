import { describe, expect, it } from "vitest";
import {
  type KeyInput,
  parseSingleKeyPreference,
  serializeSingleKeyPreference,
  SHORTCUT_HELP,
  shortcutFor,
} from "./shortcuts";

function press(key: string, code: string, extra: Partial<KeyInput> = {}): KeyInput {
  return {
    key,
    code,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    editable: false,
    ...extra,
  };
}

describe("shortcutFor", () => {
  it("maps the board's keys", () => {
    expect(shortcutFor(press("/", "Slash"))).toEqual({ type: "focus-search" });
    expect(shortcutFor(press("?", "Slash", { shiftKey: true }))).toEqual({ type: "help" });
    expect(shortcutFor(press("r", "KeyR"))).toEqual({ type: "refresh" });
    expect(shortcutFor(press("i", "KeyI"))).toEqual({ type: "toggle-issues" });
    expect(shortcutFor(press("s", "KeyS"))).toEqual({ type: "toggle-starred" });
    expect(shortcutFor(press("Escape", "Escape"))).toEqual({ type: "reset" });
  });

  it("numbers All and then the categories in filter order", () => {
    expect(shortcutFor(press("1", "Digit1"))).toEqual({ type: "category", category: "all" });
    expect(shortcutFor(press("2", "Digit2"))).toEqual({ type: "category", category: "cloud" });
    expect(shortcutFor(press("6", "Numpad6"))).toEqual({ type: "category", category: "updates" });
    expect(shortcutFor(press("7", "Digit7"))).toBeNull();
    expect(shortcutFor(press("0", "Digit0"))).toBeNull();
  });

  it("works by physical key on a non-Latin layout", () => {
    // Ukrainian layout: the R key types "к", the slash key types ".".
    expect(shortcutFor(press("к", "KeyR"))).toEqual({ type: "refresh" });
    expect(shortcutFor(press(".", "Slash"))).toEqual({ type: "focus-search" });
    expect(shortcutFor(press(",", "Slash", { shiftKey: true }))).toEqual({ type: "help" });
  });

  it("goes by the typed letter on another Latin layout", () => {
    // Dvorak: the physical R key types "p", and "r" sits on the O key.
    expect(shortcutFor(press("p", "KeyR"))).toBeNull();
    expect(shortcutFor(press("r", "KeyO"))).toEqual({ type: "refresh" });
    expect(shortcutFor(press("z", "Slash"))).toBeNull();
  });

  it("leaves browser and system shortcuts alone", () => {
    expect(shortcutFor(press("r", "KeyR", { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(press("r", "KeyR", { metaKey: true }))).toBeNull();
    expect(shortcutFor(press("1", "Digit1", { altKey: true }))).toBeNull();
    expect(shortcutFor(press("R", "KeyR", { shiftKey: true }))).toBeNull();
  });

  it("lets a text field keep its keys, except Escape", () => {
    expect(shortcutFor(press("r", "KeyR", { editable: true }))).toBeNull();
    expect(shortcutFor(press("/", "Slash", { editable: true }))).toBeNull();
    expect(shortcutFor(press("Escape", "Escape", { editable: true }))).toEqual({ type: "leave-search" });
  });

  it("ignores held-down keys", () => {
    expect(shortcutFor(press("i", "KeyI", { repeat: true }))).toBeNull();
  });
});

describe("single-key shortcuts switched off", () => {
  const off = { singleKey: false };

  it("drops every printable key", () => {
    expect(shortcutFor(press("r", "KeyR"), off)).toBeNull();
    expect(shortcutFor(press("i", "KeyI"), off)).toBeNull();
    expect(shortcutFor(press("s", "KeyS"), off)).toBeNull();
    expect(shortcutFor(press("1", "Digit1"), off)).toBeNull();
    expect(shortcutFor(press("6", "Numpad6"), off)).toBeNull();
    expect(shortcutFor(press("/", "Slash"), off)).toBeNull();
    expect(shortcutFor(press("?", "Slash", { shiftKey: true }), off)).toBeNull();
    // By physical key on a non-Latin layout, too.
    expect(shortcutFor(press("к", "KeyR"), off)).toBeNull();
    expect(shortcutFor(press(".", "Slash"), off)).toBeNull();
    expect(shortcutFor(press(",", "Slash", { shiftKey: true }), off)).toBeNull();
  });

  it("keeps Escape, which types nothing", () => {
    expect(shortcutFor(press("Escape", "Escape"), off)).toEqual({ type: "reset" });
    expect(shortcutFor(press("Escape", "Escape", { editable: true }), off)).toEqual({ type: "leave-search" });
  });

  it("marks exactly the keys the switch turns off", () => {
    const switchable = SHORTCUT_HELP.filter((item) => item.singleKey).flatMap((item) => item.keys);
    expect(switchable).toEqual(["/", "1–6", "I", "S", "R", "?"]);
    const kept = SHORTCUT_HELP.filter((item) => !item.singleKey).flatMap((item) => item.keys);
    expect(kept).toEqual(["Esc"]);
  });
});

describe("single-key preference", () => {
  it("defaults to on and round-trips", () => {
    expect(parseSingleKeyPreference(null)).toBe(true);
    expect(parseSingleKeyPreference("garbage")).toBe(true);
    expect(parseSingleKeyPreference(serializeSingleKeyPreference(false))).toBe(false);
    expect(parseSingleKeyPreference(serializeSingleKeyPreference(true))).toBe(true);
  });
});
