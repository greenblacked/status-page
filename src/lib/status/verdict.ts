import { CATALOG } from "./catalog.ts";
import { urgencyOf } from "./health.ts";
import type { BoardSnapshot, Health, ServiceId, ServiceSnapshot } from "./types.ts";

/**
 * The board's one sentence, and the lines that hang from it. The sentence is
 * the page's <h1>. It answers "is it them or is it me?" in the owner's voice:
 * first person, sentence case, one shape.
 *
 * Two ideas are kept apart on purpose:
 *   - "needs a look": outage, degraded or maintenance, something a person
 *     should open. `count` is this number.
 *   - "couldn't read": the source did not answer. That says nothing about the
 *     vendor, so it is never counted as a problem and never sets the tone of a
 *     board that has none.
 *
 * Pure: a function of one snapshot, so the page, the tab title, the JSON API
 * and the floating bar cannot disagree.
 */

/** A run of the sub line: plain text, or a service the sentence names (the page links it to its card). */
export type VerdictPart = { text: string; id?: ServiceId };

export type Verdict = {
  /** The worst state that needs a look; unknown when only unreadable sources are left; operational when calm. */
  tone: Health;
  /** The headline, "Two things need a look." Its first word is the count, spelled out. */
  title: string;
  /** The floating bar's short form, "2 need a look". */
  short: string;
  /** Services that need a look (outage, degraded, maintenance). Zero draws no pen underline. */
  count: number;
  /** The line under the headline, "Steam and Fortnite. The other twelve are running normally." Empty when calm. */
  sub: string;
  /** The same line as runs, so the page can link the services it names. */
  subParts: VerdictPart[];
  /** What a screen reader hears under the headline: the sub line, or the calm sentence the hand note stands for. */
  srSub: string;
  /** True when all is well: the page shows the handwritten "all quiet" instead of the sub line. */
  hand: boolean;
};

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
];

/** A count as a word up to fourteen (the size of the catalog), numerals after. */
export function countWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** How many names the sub line spells out before it says "and N more". */
const NAMED_MAX = 3;

/** "Steam", "Steam and Fortnite", "Steam, Fortnite and AWS", or "Steam, Fortnite, AWS and 2 more". */
function namedParts(services: ServiceSnapshot[]): VerdictPart[] {
  const shown = services.slice(0, NAMED_MAX);
  const parts: VerdictPart[] = [];
  shown.forEach((service, at) => {
    if (at > 0) parts.push({ text: at === shown.length - 1 && shown.length === services.length ? " and " : ", " });
    parts.push({ text: service.shortName, id: service.id });
  });
  if (services.length > NAMED_MAX) parts.push({ text: ` and ${services.length - NAMED_MAX} more` });
  return parts;
}

/** "I couldn't read Android.", "I couldn't read Android and Steam." (each linked), or "I couldn't read three of them." */
function unreadParts(unread: ServiceSnapshot[], lead = ""): VerdictPart[] {
  if (unread.length > 2) return [{ text: `${lead}I couldn't read ${countWord(unread.length)} of them.` }];
  return [
    { text: `${lead}I couldn't read ` },
    ...unread.flatMap((service, at) => [
      ...(at > 0 ? [{ text: " and " }] : []),
      { text: service.shortName, id: service.id },
    ]),
    { text: "." },
  ];
}

const textOf = (parts: VerdictPart[]) => parts.map((part) => part.text).join("");

export function verdict(board: BoardSnapshot): Verdict {
  const attention = board.services
    .filter(
      (service) => service.health === "outage" || service.health === "degraded" || service.health === "maintenance",
    )
    .sort((a, b) => urgencyOf(a.health) - urgencyOf(b.health));
  const unread = board.services.filter((service) => service.health === "unknown");
  const n = attention.length;
  const k = unread.length;
  const total = board.services.length || CATALOG.length;

  if (n > 0) {
    const others = total - n - k;
    const parts = namedParts(attention);
    parts.push({ text: "." });
    if (others > 0) {
      parts.push({ text: ` The other ${countWord(others)} ${others === 1 ? "is" : "are"} running normally.` });
    }
    if (k > 0) parts.push(...unreadParts(unread, " "));
    const sub = textOf(parts);
    return {
      tone: attention[0].health,
      title: `${capital(countWord(n))} ${n === 1 ? "thing needs" : "things need"} a look.`,
      short: `${n} ${n === 1 ? "needs" : "need"} a look`,
      count: n,
      sub,
      subParts: parts,
      srSub: sub,
      hand: false,
    };
  }

  if (k > 0) {
    const parts = unreadParts(unread);
    const sub = textOf(parts);
    return {
      tone: "unknown",
      title: "Nothing needs a look.",
      short: "Nothing needs a look",
      count: 0,
      sub,
      subParts: parts,
      srSub: sub,
      hand: false,
    };
  }

  return {
    tone: "operational",
    title: "Everything is up.",
    short: "Everything is up",
    count: 0,
    sub: "",
    subParts: [],
    srSub: `All ${countWord(total)} services are running normally.`,
    hand: true,
  };
}
