import { formatUtcTime, THIN_SPACE } from "@/lib/status/schedule";

/**
 * Times on the board are in the viewer's own zone once the page has hydrated
 * (always in English, whatever the browser's language), and UTC before that:
 * the server cannot know the viewer's zone, and a hydrating render must print
 * what the server printed. This file is the pure part (the formatters, all
 * taking the zone as an argument so a test can pin it);
 * src/components/status/local-time.tsx does the switching.
 *
 *   clock  "12:04 CET"  (a date first when it is not the reference's day)
 *   slot   "12:04 CET"  (never a date: a slot is one of the last few checks)
 *   date   "Wednesday 30 September"
 */
export type LocalTimeFormat = "clock" | "date" | "slot";

/**
 * Which zone to format in; the viewer's own when left out. `locale` is the
 * viewer's language and is accepted so a caller can pass it, but it never
 * changes the output: dates and times are always English.
 */
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

/** One moment read in a zone: numbers and the zone's English abbreviation, nothing from the viewer's language. */
type Moment = { year: number; month: number; day: number; hour: number; minute: number; zone: string };

const formatters = new Map<string, Intl.DateTimeFormat>();
const zoneNames = new Map<string, Intl.DateTimeFormat>();

const isOffset = (name: string) => /^GMT[+-]/.test(name);

/** en-GB names Europe's zones (CET, BST) and en-US the Americas' (EDT, PST); an offset when neither has one. */
function zoneName(at: number, timeZone: string | undefined, fromGb: string): string {
  if (!isOffset(fromGb)) return fromGb;
  const key = timeZone ?? "";
  let us = zoneNames.get(key);
  if (!us) {
    us = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" });
    zoneNames.set(key, us);
  }
  const fromUs = us.formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "";
  return fromUs && !isOffset(fromUs) ? fromUs : fromGb;
}

/**
 * The moment's parts in a zone. The language is pinned to English on purpose:
 * the whole site is English, so a browser set to Russian must not turn the
 * weekday, the digits, the 24-hour clock or the zone name ("GMT+3") into its
 * own. Only the numeric parts are read, and the words come from the arrays above.
 */
function momentIn(at: number, timeZone: string | undefined): Moment {
  const key = timeZone ?? "";
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    formatters.set(key, formatter);
  }
  const value = Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, part.value]));
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
    hour: Number(value.hour) % 24,
    minute: Number(value.minute),
    zone: zoneName(at, timeZone, value.timeZoneName ?? ""),
  };
}

const sameDay = (a: Moment, b: Moment) => a.year === b.year && a.month === b.month && a.day === b.day;

/**
 * A moment as a clock time with its zone, "12:04 CET", in 24 hours with an
 * English zone abbreviation. With `reference` given, a moment on another local
 * day than the reference gets its date first ("26 Sep 12:04 CET", and the year
 * too when it differs), the way formatUtcTime does for UTC. `options.locale`
 * does not change the language of the result.
 */
export function formatLocalTime(at: number, reference: number = at, options: ZoneOptions = {}): string {
  const mine = momentIn(at, options.timeZone);
  // A thin no-break space before the zone, like formatUtcTime's, so "12:04 CET" never breaks in two.
  const clock = `${pad(mine.hour)}:${pad(mine.minute)}${THIN_SPACE}${mine.zone}`;
  const other = momentIn(reference, options.timeZone);
  if (sameDay(mine, other)) return clock;
  const day = `${mine.day} ${MONTHS[mine.month - 1]}`;
  return mine.year === other.year ? `${day} ${clock}` : `${day} ${mine.year} ${clock}`;
}

/** The date in the viewer's own zone, in English, "Wednesday 30 September" (no comma, like formatUtcDate). */
export function formatLocalDate(at: number, options: ZoneOptions = {}): string {
  const { year, month, day } = momentIn(at, options.timeZone);
  // The weekday of a calendar date does not depend on the zone, so read it off the date in UTC.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${day} ${MONTHS_LONG[month - 1]}`;
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
