import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANCHOR_APPLE,
  ANCHOR_RELEASES,
  ANCHOR_STATUS,
  ANCHOR_WINDOWS,
  cannedPayload,
  ROUTES,
  shiftDates,
} from "../../e2e/support/canned-vendors.mjs";

// The dates in the e2e preview's canned vendor payloads move from the moment each fixture was written around to
// the present (e2e/support/canned-vendors.mjs), in every format the fixtures spell them.

const FIXTURES = new URL("../../src/lib/status/__fixtures__/", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, FIXTURES), "utf8");

const DAY = 86_400_000;
const FROM = Date.parse("2026-09-20T12:00:00.000Z");
/** `text` moved from FROM by `ms`. */
const moved = (text: string, ms: number) => shiftDates(text, FROM, FROM + ms);

describe("shiftDates", () => {
  it("moves ISO stamps in Z and in an offset, keeping the fraction and the zone", () => {
    expect(moved("2026-09-20T09:30:00Z", 2 * DAY)).toBe("2026-09-22T09:30:00Z");
    expect(moved("2026-09-20T09:30:00.250Z", 3_600_000)).toBe("2026-09-20T10:30:00.250Z");
    expect(moved("2026-09-20T09:30:00+00:00", DAY)).toBe("2026-09-21T09:30:00+00:00");
    // The wall clock moves, the offset stays: a stamp 7 hours behind UTC keeps saying so.
    expect(moved("2026-09-30T20:00:00-07:00", 5 * 3_600_000)).toBe("2026-10-01T01:00:00-07:00");
    expect(moved("2026-09-20T09:30:00.123456Z", 1000)).toBe("2026-09-20T09:30:01.123456Z");
    expect(moved('{"a":"2026-12-31T23:59:59Z"}', 1000)).toBe('{"a":"2027-01-01T00:00:00Z"}');
  });

  it("moves RFC 822 stamps in GMT, a US zone name, Z and a numeric offset, with the weekday and padding of each", () => {
    expect(moved("Sun, 20 Sep 2026 09:30:00 GMT", DAY)).toBe("Mon, 21 Sep 2026 09:30:00 GMT");
    expect(moved("Sun, 20 Sep 2026 09:30:00 PDT", 2 * DAY)).toBe("Tue, 22 Sep 2026 09:30:00 PDT");
    expect(moved("Sun, 20 Sep 2026 09:30:00 +0000", DAY)).toBe("Mon, 21 Sep 2026 09:30:00 +0000");
    expect(moved("<pubDate>Sun, 20 Sep 2026 09:30:00 Z</pubDate>", 3_600_000)).toBe(
      "<pubDate>Sun, 20 Sep 2026 10:30:00 Z</pubDate>",
    );
    expect(moved("Sun, 20 Sep 2026 09:30:00 -0700", 12 * 3_600_000)).toBe("Sun, 20 Sep 2026 21:30:00 -0700");
    // Padding follows the original, the weekday follows the date, the month and the year roll over.
    expect(moved("Thu, 1 Oct 2026 08:00:00 GMT", 30 * DAY)).toBe("Sat, 31 Oct 2026 08:00:00 GMT");
    expect(moved("Thu, 01 Oct 2026 08:00:00 GMT", 100 * DAY)).toBe("Sat, 09 Jan 2027 08:00:00 GMT");
    // No weekday in, none out.
    expect(moved("20 Sep 2026 09:30:00 GMT", DAY)).toBe("21 Sep 2026 09:30:00 GMT");
  });

  it("moves Unix seconds, ten digits, and leaves other numbers alone", () => {
    expect(moved('"date": "1789898400"', 2 * DAY)).toBe(`"date": "${1789898400 + 2 * 86_400}"`);
    expect(moved('"timestamp": 1789812000,', 3_600_000)).toBe('"timestamp": 1789815600,');
    // A MikroTik channel file: the version, then the seconds.
    expect(moved("7.20.2 1789473600\n", DAY)).toBe(`7.20.2 ${1789473600 + 86_400}\n`);
    // Nine and eleven digits, a longer run, a decimal, a word with digits in it, and a number outside 2020-2029.
    for (const other of [
      "178989840",
      "17898984000",
      "123456789012345678",
      "1789898400.5",
      "id1789898400",
      "1789898400x",
      "9789898400",
      "1589898400",
    ]) {
      expect(moved(`value ${other} end`, DAY)).toBe(`value ${other} end`);
    }
  });

  it("moves bare days by whole UTC days, and leaves ids, slugs and impossible days", () => {
    expect(moved("<td>2026-09-29</td>", 2 * DAY)).toBe("<td>2026-10-01</td>");
    // A fraction of a day carries over only when the clock crosses midnight: 12:00 + 13h is the next day.
    expect(moved("2026-09-29", 13 * 3_600_000)).toBe("2026-09-30");
    expect(moved("2026-09-29", 11 * 3_600_000)).toBe("2026-09-29");
    expect(moved("(2026-10-01)", DAY)).toBe("(2026-10-02)");
    expect(moved("2026-09-20-title-slug 2026-09-20-", DAY)).toBe("2026-09-20-title-slug 2026-09-20-");
    expect(moved("x2026-09-20", DAY)).toBe("x2026-09-20");
    expect(moved("2026-13-45 2026-02-30", DAY)).toBe("2026-13-45 2026-02-30");
  });

  it("moves RouterOS changelog dates, with the time or without", () => {
    expect(moved("What's new in 7.21beta4 (2026-Sep-19 12:00):", DAY)).toBe(
      "What's new in 7.21beta4 (2026-Sep-20 12:00):",
    );
    expect(moved("(2026-Sep-30 23:30)", 2 * 3_600_000)).toBe("(2026-Oct-01 01:30)");
    expect(moved("(2026-Sep-29)", 2 * DAY)).toBe("(2026-Oct-01)");
  });

  it("moves each date once, whatever mix a line has", () => {
    const line =
      '{"at":"2026-09-20T12:00:00Z","pub":"Sun, 20 Sep 2026 12:00:00 GMT","unix":1789905600,"day":"2026-09-20"}';
    expect(moved(line, DAY)).toBe(
      '{"at":"2026-09-21T12:00:00Z","pub":"Mon, 21 Sep 2026 12:00:00 GMT","unix":1789991999,"day":"2026-09-21"}'.replace(
        "1789991999",
        String(1789905600 + 86_400),
      ),
    );
  });

  it("is the identity at no distance and undone by the opposite move", () => {
    const text = "2026-09-20T09:30:00.5+02:00 Sun, 20 Sep 2026 09:30:00 PDT 1789898400 2026-09-29 (2026-Sep-19 12:00)";
    expect(moved(text, 0)).toBe(text);
    const there = shiftDates(text, FROM, FROM + 13.5 * DAY);
    expect(there).not.toBe(text);
    expect(shiftDates(there, FROM + 13.5 * DAY, FROM)).toBe(text);
  });
});

describe("the routed fixtures", () => {
  const routes = Object.entries(ROUTES);
  // Payloads with no date in them.
  const undated = new Set(["gcp/products.json", "play/products.json", "grok/components.json", "steam/cm-list.json"]);

  it("route to fixtures written around a known clock", () => {
    expect(new Set(routes.map(([, route]) => route.anchor))).toEqual(
      new Set([ANCHOR_STATUS, ANCHOR_APPLE, ANCHOR_WINDOWS, ANCHOR_RELEASES]),
    );
    // The release feeds were written on 2026-10-01 and -02, the status payloads on the 20th of September.
    expect(ANCHOR_RELEASES).toBeGreaterThan(ANCHOR_WINDOWS);
    expect(ANCHOR_WINDOWS).toBeGreaterThan(ANCHOR_APPLE);
    expect(ANCHOR_APPLE).toBeGreaterThan(ANCHOR_STATUS);
  });

  it.each(routes)("%s: its dates move, and move back", (_url, route) => {
    const text = read(route.file);
    expect(shiftDates(text, route.anchor, route.anchor)).toBe(text);
    const later = route.anchor + 13.5 * DAY;
    const shifted = shiftDates(text, route.anchor, later);
    expect(shifted === text).toBe(undated.has(route.file));
    expect(shiftDates(shifted, later, route.anchor)).toBe(text);
  });

  it("have only Unix seconds among their ten-digit numbers, so nothing else is moved by that rule", () => {
    const files = [
      ...routes.map(([, route]) => route.file),
      "mikrotik/NEWESTa6.long-term",
      "mikrotik/7.20.2/CHANGELOG",
    ];
    const found: string[] = [];
    for (const file of new Set(files)) {
      for (const match of read(file).matchAll(/(?<![\w.])\d{10}(?![\w.])/g)) {
        found.push(match[0]);
        expect(Number(match[0]), `${file}: ${match[0]}`).toBeGreaterThan(1.6e9);
        expect(Number(match[0]), `${file}: ${match[0]}`).toBeLessThan(1.9e9);
      }
    }
    // AWS events (3 dates and their log lines), the CS2 news and the five MikroTik channels are among them.
    expect(found.length).toBeGreaterThanOrEqual(10);
  });

  it("move the AWS Health epoch seconds, MikroTik channels and CS2 news with the rest (a canned board does not age)", () => {
    const now = Date.parse("2026-10-04T08:00:00.000Z");
    const aws = cannedPayload(new URL("https://health.aws.amazon.com/public/currentevents"), now);
    expect(aws?.utf16).toBe(true);
    const events = JSON.parse(aws?.body ?? "[]") as { date: string }[];
    // The first event began two hours before the status payloads' moment.
    expect(Number(events[0].date) * 1000).toBe(now - 2 * 3_600_000);

    const stable = cannedPayload(new URL("https://upgrade.mikrotik.com/routeros/NEWESTa7.stable"), now);
    expect(Number(stable?.body.trim().split(/\s+/)[1]) * 1000).toBe(
      Date.parse("2026-09-15T12:00:00Z") + (now - ANCHOR_STATUS),
    );

    const steam = cannedPayload(
      new URL(
        "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=730&count=10&maxlength=300&feeds=steam_community_announcements",
      ),
      now,
    );
    const news = JSON.parse(steam?.body ?? "{}") as { appnews: { newsitems: { date: number }[] } };
    // Its newest post sits on the release feeds' clock, not in the future of it.
    expect(news.appnews.newsitems[0].date * 1000).toBe(now - (ANCHOR_RELEASES - 1790874000 * 1000));
  });

  it("keep each fixture group's age: nothing written before its clock lands after the present", () => {
    const now = Date.parse("2026-10-04T08:00:00.000Z");
    const feed = cannedPayload(new URL("https://docs.gitlab.com/releases/all-releases.xml"), now);
    const published = [...(feed?.body ?? "").matchAll(/<published>([^<]+)<\/published>/g)].map((m) => Date.parse(m[1]));
    expect(published.length).toBeGreaterThan(0);
    for (const time of published) expect(time).toBeLessThanOrEqual(now);

    const whatsNew = cannedPayload(new URL("https://aws.amazon.com/about-aws/whats-new/recent/feed/"), now);
    const pubs = [...(whatsNew?.body ?? "").matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map((m) => Date.parse(m[1]));
    expect(pubs.length).toBeGreaterThan(0);
    for (const time of pubs) expect(time).toBeLessThanOrEqual(now);
  });
});

describe("cannedPayload", () => {
  it("answers a vendor URL, a MikroTik file and a changelog, and nothing else", () => {
    const now = Date.parse("2026-10-04T08:00:00.000Z");
    expect(cannedPayload(new URL("https://www.githubstatus.com/api/v2/summary.json"), now)?.type).toBe(
      "application/json",
    );
    expect(cannedPayload(new URL("https://status.x.ai/feed.xml"), now)?.type).toBe("text/xml");
    expect(cannedPayload(new URL("https://download.mikrotik.com/routeros/7.21beta4/CHANGELOG"), now)?.body).toContain(
      "(2026-Oct-03 08:00):",
    );
    expect(cannedPayload(new URL("https://example.com/"), now)).toBeUndefined();
    expect(cannedPayload(new URL("https://download.mikrotik.com/routeros/9.9.9/CHANGELOG"), now)).toBeUndefined();
  });
});
