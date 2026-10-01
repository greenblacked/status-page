import { formatUtcTime, THIN_SPACE } from "@/lib/status/schedule";

/**
 * Times on the board are the viewer's own once the page has hydrated, and UTC
 * before that: the server cannot know the viewer's zone, and a hydrating render
 * must print what the server printed. This file is the pure part (the
 * formatters, all taking the zone and locale as arguments so a test can pin
 * them); src/components/status/local-time.tsx does the switching.
 *
 *   clock  "12:04 CET"  (a date first when it is not the reference's day)
 *   slot   "12:04 CET"  (never a date: a slot is one of the last few checks)
 *   date   "Wednesday 30 September"
 */
export type LocalTimeFormat = "clock" | "date" | "slot";

/** Which zone and locale to format in; the viewer's own when left out. */
export type ZoneOptions = { timeZone?: string; locale?: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => n.toString().padStart(2, "0");

/** The `title` of every time: the whole moment in UTC, "30 Sep 2026 10:04 UTC". Never translated. */
export function formatUtcTitle(at: number): string {
  const date = new Date(at);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** The server's and the hydrating render's date, "Wednesday 30 September", from the UTC calendar. */
export function formatUtcDate(at: number): string {
  const date = new Date(at);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS_LONG[date.getUTCMonth()]}`;
}

/** The calendar day of `at` in a zone, as a comparable key. */
function dayKey(at: number, { timeZone, locale }: ZoneOptions): string {
  return new Intl.DateTimeFormat(locale, { timeZone, year: "numeric", month: "numeric", day: "numeric" }).format(at);
}

/**
 * A moment as a clock time with its zone, "12:04 CET". With `reference` given,
 * a moment on another local day than the reference gets its date first
 * ("26 Sep 12:04 CET", and the year too when it differs), the way
 * formatUtcTime does for UTC.
 */
export function formatLocalTime(at: number, reference: number = at, options: ZoneOptions = {}): string {
  const { timeZone, locale } = options;
  // A thin no-break space before the zone, like formatUtcTime's, so "12:04 CET" never breaks in two.
  const clock = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  })
    .format(at)
    .replace(/\s+(?=\S+$)/, THIN_SPACE);
  if (dayKey(at, options) === dayKey(reference, options)) return clock;
  const parts = (moment: number) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "numeric", year: "numeric" })
        .formatToParts(moment)
        .map((part) => [part.type, part.value]),
    );
  const mine = parts(at);
  const day = `${mine.day} ${MONTHS[Number(mine.month) - 1]}`;
  return mine.year === parts(reference).year ? `${day} ${clock}` : `${day} ${mine.year} ${clock}`;
}

/** The date in the viewer's own zone and language, "Wednesday 30 September". */
export function formatLocalDate(at: number, options: ZoneOptions = {}): string {
  const { timeZone, locale } = options;
  return new Intl.DateTimeFormat(locale, { timeZone, weekday: "long", day: "numeric", month: "long" }).format(at);
}

/** What a time reads before the page has hydrated: UTC, the same text on the server and in the browser. */
export function formatBeforeHydration(at: number, reference: number, format: LocalTimeFormat): string {
  if (format === "date") return formatUtcDate(at);
  return formatUtcTime(at, format === "slot" ? at : reference);
}

/** What a time reads after hydration: the viewer's own. */
export function formatAfterHydration(
  at: number,
  reference: number,
  format: LocalTimeFormat,
  options: ZoneOptions = {},
): string {
  if (format === "date") return formatLocalDate(at, options);
  return formatLocalTime(at, format === "slot" ? at : reference, options);
}
