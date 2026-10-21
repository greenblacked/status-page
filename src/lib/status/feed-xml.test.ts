import { describe, expect, it } from "vitest";
import { parseFeedDate } from "./feed-xml.ts";

describe("parseFeedDate", () => {
  it("reads an RFC 822 date with a zone abbreviation Date.parse does not know", () => {
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 CEST")).toBe(Date.parse("2026-09-21T08:00:00Z"));
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 cet")).toBe(Date.parse("2026-09-21T09:00:00Z"));
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 BST")).toBe(Date.parse("2026-09-21T09:00:00Z"));
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 IST")).toBe(Date.parse("2026-09-21T04:30:00Z"));
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 JST")).toBe(Date.parse("2026-09-21T01:00:00Z"));
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 AEDT")).toBe(Date.parse("2026-09-20T23:00:00Z"));
  });

  it("reads the forms Date.parse already knows: GMT, a US zone and a numeric offset", () => {
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 GMT")).toBe(Date.parse("2026-09-21T10:00:00Z"));
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 PDT")).toBe(Date.parse("2026-09-21T17:00:00Z"));
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 +0200")).toBe(Date.parse("2026-09-21T08:00:00Z"));
    expect(parseFeedDate("2026-09-21T10:00:00-04:00")).toBe(Date.parse("2026-09-21T14:00:00Z"));
  });

  it("reads a date and time with no zone as UTC, whatever the host's zone", () => {
    expect(parseFeedDate("2026-09-21 10:00")).toBe(Date.parse("2026-09-21T10:00:00Z"));
    expect(parseFeedDate(" 2026-09-21 10:00:30 ")).toBe(Date.parse("2026-09-21T10:00:30Z"));
    expect(parseFeedDate("2026-09-21T10:00:30")).toBe(Date.parse("2026-09-21T10:00:30Z"));
  });

  it("is undefined for nothing, garbage and an unknown zone", () => {
    expect(parseFeedDate(undefined)).toBeUndefined();
    expect(parseFeedDate("")).toBeUndefined();
    expect(parseFeedDate("   ")).toBeUndefined();
    expect(parseFeedDate("yesterday")).toBeUndefined();
    expect(parseFeedDate("Mon, 21 Sep 2026 10:00:00 XYZ")).toBeUndefined();
    expect(parseFeedDate(`Mon, 21 Sep 2026 10:00:00 ${"CEST ".repeat(100)}`)).toBeUndefined();
  });
});
