import { describe, expect, it } from "vitest";
import {
  formatAfterHydration,
  formatBeforeHydration,
  formatLocalDate,
  formatLocalTime,
  formatUtcDate,
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

describe("before and after hydration", () => {
  it("shows UTC first, in the text the server printed", () => {
    expect(formatBeforeHydration(at, at, "clock")).toBe("10:04\u202fUTC");
    expect(formatBeforeHydration(at, at, "slot")).toBe("10:04\u202fUTC");
    expect(formatBeforeHydration(at, at, "date")).toBe("Wednesday 30 September");
    const yesterday = Date.parse("2026-09-29T09:00:00Z");
    expect(formatBeforeHydration(yesterday, at, "clock")).toBe("29 Sep 09:00\u202fUTC");
    // A slot never carries a date.
    expect(formatBeforeHydration(yesterday, at, "slot")).toBe("09:00\u202fUTC");
  });

  it("then the viewer's own", () => {
    expect(formatAfterHydration(at, at, "clock", berlin)).toBe("12:04\u202fCEST");
    expect(formatAfterHydration(at, at, "slot", berlin)).toBe("12:04\u202fCEST");
    expect(formatAfterHydration(at, at, "date", berlin)).toBe("Wednesday 30 September");
    const yesterday = Date.parse("2026-09-29T09:00:00Z");
    expect(formatAfterHydration(yesterday, at, "clock", berlin)).toBe("29 Sep 11:00\u202fCEST");
    expect(formatAfterHydration(yesterday, at, "slot", berlin)).toBe("11:00\u202fCEST");
  });
});
