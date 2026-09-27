import { CATEGORIES } from "./catalog.ts";
import type { CategoryId } from "./types.ts";

export type ShortcutAction =
  | { type: "focus-search" }
  | { type: "leave-search" }
  | { type: "refresh" }
  | { type: "category"; category: "all" | CategoryId }
  | { type: "toggle-issues" }
  | { type: "toggle-starred" }
  | { type: "reset" }
  | { type: "help" };

/** The parts of a KeyboardEvent a shortcut depends on. */
export type KeyInput = {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  /** Focus is in a text field, where keys belong to the field. */
  editable: boolean;
};

/** 1 is All, then the categories in the order the filter row shows them. */
const NUMBERED: Array<"all" | CategoryId> = ["all", ...CATEGORIES.map((category) => category.id)];

// A letter matches by the character it types. On a Cyrillic or other
// non-Latin layout, where no key types it, the physical key stands in.
function letter(input: KeyInput, char: string): boolean {
  if (/^[a-z]$/i.test(input.key)) return input.key.toLowerCase() === char;
  return input.code === `Key${char.toUpperCase()}`;
}

function digit(input: KeyInput): number | null {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(input.code) ?? /^([0-9])$/.exec(input.key);
  return match ? Number(match[1]) : null;
}

export type ShortcutOptions = {
  /**
   * Every shortcut that is one printable key: `/`, `?`, R, I, S and 1–6. A
   * speech-input user who dictates types characters, each of which would
   * fire one (WCAG 2.1.4), so they can be switched off together. Esc stays:
   * it types nothing. The search box and the footer's keyboard shortcuts
   * button, which holds the switch, stay a Tab away.
   */
  singleKey: boolean;
};

export const DEFAULT_SHORTCUT_OPTIONS: ShortcutOptions = { singleKey: true };

export function shortcutFor(
  input: KeyInput,
  options: ShortcutOptions = DEFAULT_SHORTCUT_OPTIONS,
): ShortcutAction | null {
  // Browser and system shortcuts (Ctrl+R, Cmd+1) stay theirs.
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  if (input.editable) return input.key === "Escape" ? { type: "leave-search" } : null;
  if (input.repeat) return null;

  if (input.key === "Escape") return { type: "reset" };
  if (!options.singleKey) return null;

  // The slash key types "." on a Ukrainian layout but a letter on Dvorak,
  // where the letter's own shortcut, if any, wins.
  const slashKey = input.code === "Slash" && !/^[a-z]$/i.test(input.key);
  if (input.key === "?" || (slashKey && input.shiftKey)) return { type: "help" };
  if (input.key === "/" || slashKey) return { type: "focus-search" };
  if (input.shiftKey) return null;
  if (letter(input, "r")) return { type: "refresh" };
  if (letter(input, "i")) return { type: "toggle-issues" };
  if (letter(input, "s")) return { type: "toggle-starred" };

  const number = digit(input);
  const category = number === null ? undefined : NUMBERED[number - 1];
  return category ? { type: "category", category } : null;
}

/**
 * What the help dialog lists, in the order it lists them. `singleKey` marks
 * the keys the single-key switch turns off.
 */
export const SHORTCUT_HELP: Array<{ keys: string[]; label: string; singleKey: boolean }> = [
  { keys: ["/"], label: "Search services", singleKey: true },
  {
    keys: [`1–${NUMBERED.length}`],
    label: `All, ${CATEGORIES.map((category) => category.label).join(", ")}`,
    singleKey: true,
  },
  { keys: ["I"], label: "Issues only", singleKey: true },
  { keys: ["S"], label: "Starred only", singleKey: true },
  { keys: ["R"], label: "Refresh now", singleKey: true },
  { keys: ["Esc"], label: "Clear search and filters", singleKey: false },
  { keys: ["?"], label: "Show these shortcuts", singleKey: true },
];

export const SINGLE_KEY_STORAGE_KEY = "status-bar:single-key-shortcuts";

/** On unless this browser switched them off; anything unreadable counts as on. */
export function parseSingleKeyPreference(raw: string | null): boolean {
  return raw !== "off";
}

export function serializeSingleKeyPreference(on: boolean): string {
  return on ? "on" : "off";
}
