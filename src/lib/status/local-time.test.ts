import { describe, expect, it } from "vitest";
import {
  formatAfterHydration,
  formatBeforeHydration,
  formatLocalDate,
  formatLocalDay,
  formatLocalTime,
  formatUtcDate,
  formatUtcDay,
  formatUtcTitle,
} from "./local-time";

const at = Date.parse("2026-09-30T10:04:00Z");
const berlin = { timeZone: "Europe/Berlin", locale: "en-GB" };
const utc = { timeZone: "UTC", locale: "en-GB" };

describe("formatUtcTitle", () => {
  it("is the whole moment in UTC, whatever the zone the process runs in", () => {
    expect(formatUtcTitle(at)).toBe("30 Sep 2026 10:04 UTC");
    expect(formatUtcTitle(Date.parse("2027-01-02T00:05:00Z"))).toBe("2 Jan 2027 00:05 UTC");
  });
});

describe("formatUtcDate", () => {
  it("names the weekday, day and month in UTC", () => {
    expect(formatUtcDate(at)).toBe("Wednesday 30 September");
    expect(formatUtcDate(Date.parse("2026-01-01T23:59:00Z"))).toBe("Thursday 1 January");
  });
});

describe("formatLocalTime", () => {
  it("prints the clock with the zone's own abbreviation", () => {
    expect(formatLocalTime(at, at, berlin)).toBe("12:04\u202fCEST");
    expect(formatLocalTime(Date.parse("2026-12-01T10:04:00Z"), undefined, berlin)).toBe("11:04\u202fCET");
  });

  it("matches the UTC text exactly when the viewer is on UTC, so nothing shifts on hydration", () => {
    expect(formatLocalTime(at, at, utc)).toBe("10:04\u202fUTC");
  });

  it("puts the date first when the local day is not the reference's", () => {
    const reference = Date.parse("2026-09-30T10:04:00Z");
    expect(formatLocalTime(Date.parse("2026-09-29T21:30:00Z"), reference, berlin)).toBe("29 Sep 23:30\u202fCEST");
    expect(formatLocalTime(Date.parse("2026-09-29T21:30:00Z"), reference, utc)).toBe("29 Sep 21:30\u202fUTC");
    expect(formatLocalTime(Date.parse("2025-12-31T21:30:00Z"), reference, berlin)).toBe("31 Dec 2025 22:30\u202fCET");
  });

  it("compares local days, not UTC days", () => {
    // 22:30\u202fUTC and 00:30\u202fUTC next day are both 00:30 to 02:30 in Berlin: different local days.
    const late = Date.parse("2026-09-29T22:30:00Z");
    const early = Date.parse("2026-09-30T00:30:00Z");
    expect(formatLocalTime(late, early, berlin)).toBe("00:30\u202fCEST");
    expect(formatLocalTime(late, early, utc)).toBe("29 Sep 22:30\u202fUTC");
  });
});

describe("formatLocalDate", () => {
  it("is the viewer's own calendar day", () => {
    expect(formatLocalDate(at, berlin)).toBe("Wednesday 30 September");
    // 23:30\u202fUTC is already the next day in Berlin.
    expect(formatLocalDate(Date.parse("2026-09-30T23:30:00Z"), berlin)).toBe("Thursday 1 October");
    expect(formatLocalDate(Date.parse("2026-09-30T23:30:00Z"), utc)).toBe("Wednesday 30 September");
  });
});

// The whole site is English, so no browser language may change a date or a time: not the words, the
// punctuation, the digits, the 12/24-hour clock, nor the zone's name.
describe("formatUtcDay and formatLocalDay", () => {
  it("name the day without a time, and the year only when it is not the reference's", () => {
    expect(formatUtcDay(Date.parse("2026-09-29T00:00:00Z"), at)).toBe("29 Sep");
    expect(formatUtcDay(Date.parse("2025-09-30T00:00:00Z"), at)).toBe("30 Sep 2025");
    expect(formatUtcDay(at)).toBe("30 Sep");
    expect(formatLocalDay(Date.parse("2026-09-29T12:00:00Z"), at, utc)).toBe("29 Sep");
    expect(formatLocalDay(Date.parse("2025-01-02T12:00:00Z"), at, berlin)).toBe("2 Jan 2025");
  });

  it("read the day in the viewer's zone, English whatever the browser's language", () => {
    const lateEvening = Date.parse("2026-09-30T23:30:00Z");
    expect(formatLocalDay(lateEvening, at, berlin)).toBe("1 Oct");
    expect(formatLocalDay(lateEvening, at, utc)).toBe("30 Sep");
    expect(formatLocalDay(lateEvening, at, { timeZone: "Europe/Moscow", locale: "ru-RU" })).toBe("1 Oct");
  });
});

describe("in any browser language", () => {
  const locales = ["ru-RU", "de-DE", "ar-EG", "en-US", "ja-JP", "fa-IR"];
  const moscow = (locale: string) => ({ timeZone: "Europe/Moscow", locale });
  const afternoon = Date.parse("2026-09-30T14:04:00Z");

  it.each(locales)("prints the date in English for %s", (locale) => {
    expect(formatLocalDate(Date.parse("2026-09-30T23:30:00Z"), { timeZone: "Europe/Moscow", locale })).toBe(
      "Thursday 1 October",
    );
    expect(formatLocalDate(at, { timeZone: "Europe/Berlin", locale })).toBe(formatUtcDate(at));
  });

  it.each(locales)("prints a 24-hour clock with an English zone for %s", (locale) => {
    expect(formatLocalTime(afternoon, afternoon, { timeZone: "Europe/Berlin", locale })).toBe("16:04\u202fCEST");
    expect(formatLocalTime(afternoon, afternoon, moscow(locale))).toBe("17:04\u202fGMT+3");
    expect(formatLocalTime(afternoon, afternoon, { timeZone: "UTC", locale })).toBe("14:04\u202fUTC");
    // Midnight is 00:00, never 24:00 or 12:00 AM.
    expect(formatLocalTime(Date.parse("2026-09-30T22:05:00Z"), undefined, { timeZone: "Europe/Berlin", locale })).toBe(
      "00:05\u202fCEST",
    );
  });

  it.each(locales)("names American zones the English way for %s", (locale) => {
    const newYork = { timeZone: "America/New_York", locale };
    expect(formatLocalTime(afternoon, afternoon, newYork)).toBe("10:04\u202fEDT");
    const january = Date.parse("2027-01-15T14:04:00Z");
    expect(formatLocalTime(january, january, newYork)).toBe("09:04\u202fEST");
    expect(formatLocalTime(afternoon, afternoon, { timeZone: "America/Los_Angeles", locale })).toBe("07:04\u202fPDT");
  });

  it.each(locales)("prints the cross-day form in English for %s", (locale) => {
    const reference = Date.parse("2026-09-30T10:04:00Z");
    const options = { timeZone: "Europe/Berlin", locale };
    expect(formatLocalTime(Date.parse("2026-09-26T10:04:00Z"), reference, options)).toBe("26 Sep 12:04\u202fCEST");
    expect(formatLocalTime(Date.parse("2025-12-31T10:04:00Z"), reference, options)).toBe("31 Dec 2025 11:04\u202fCET");
  });

  it.each(locales)("uses only ASCII digits and letters for %s", (locale) => {
    const options = { timeZone: "Asia/Kolkata", locale };
    const text = [
      formatLocalDate(afternoon, options),
      formatLocalTime(afternoon, afternoon, options),
      formatLocalTime(Date.parse("2025-12-31T10:04:00Z"), afternoon, options),
    ].join(" ");
    expect(text).toMatch(/^[ -~\u202f]+$/);
    expect(text).toContain("19:34\u202fGMT+5:30");
  });
});

describe("before and after hydration", () => {
  it("shows UTC first, in the text the server printed", () => {
    expect(formatBeforeHydration(at, at, "clock")).toBe("10:04\u202fUTC");
    expect(formatBeforeHydration(at, at, "slot")).toBe("10:04\u202fUTC");
    expect(formatBeforeHydration(at, at, "date")).toBe("Wednesday 30 September");
    const yesterday = Date.parse("2026-09-29T09:00:00Z");
    expect(formatBeforeHydration(yesterday, at, "clock")).toBe("29 Sep 09:00\u202fUTC");
    // A slot never carries a date.
    expect(formatBeforeHydration(yesterday, at, "slot")).toBe("09:00\u202fUTC");
    expect(formatBeforeHydration(yesterday, at, "day")).toBe("29 Sep");
  });

  it("then the viewer's own", () => {
    expect(formatAfterHydration(at, at, "clock", berlin)).toBe("12:04\u202fCEST");
    expect(formatAfterHydration(at, at, "slot", berlin)).toBe("12:04\u202fCEST");
    expect(formatAfterHydration(at, at, "date", berlin)).toBe("Wednesday 30 September");
    const yesterday = Date.parse("2026-09-29T09:00:00Z");
    expect(formatAfterHydration(yesterday, at, "clock", berlin)).toBe("29 Sep 11:00\u202fCEST");
    expect(formatAfterHydration(yesterday, at, "slot", berlin)).toBe("11:00\u202fCEST");
    expect(formatAfterHydration(yesterday, at, "day", berlin)).toBe("29 Sep");
  });
});
