import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CATALOG } from "@/lib/status/catalog";
import { hostOf, IncidentSince, penSeed, StateWord, stateWord } from "./service-card-shared";

describe("stateWord", () => {
  it("uses the board's words, and No data for a source that could not be read", () => {
    expect(stateWord("operational")).toBe("Operational");
    expect(stateWord("degraded")).toBe("Degraded");
    expect(stateWord("outage")).toBe("Outage");
    expect(stateWord("maintenance")).toBe("Maintenance");
    expect(stateWord("unknown")).toBe("No data");
  });
});

describe("StateWord", () => {
  const html = (health: Parameters<typeof stateWord>[0]) => renderToStaticMarkup(createElement(StateWord, { health }));

  it("is light for what is fine and semibold in its own colour for what is not", () => {
    expect(html("operational")).toContain("text-subtle");
    expect(html("operational")).not.toContain("font-semibold");
    expect(html("degraded")).toContain("text-warn");
    expect(html("degraded")).toContain("font-semibold");
    expect(html("outage")).toContain("text-down");
    expect(html("outage")).toContain("font-semibold");
    expect(html("unknown")).toContain("text-unknown");
    expect(html("unknown")).not.toContain("font-semibold");
  });
});

describe("hostOf", () => {
  it("says the host a link goes to, without www", () => {
    expect(hostOf("https://www.steamstat.us/", "Steam")).toBe("steamstat.us");
    expect(hostOf("https://health.aws.amazon.com/health/status", "AWS")).toBe("health.aws.amazon.com");
  });

  it("falls back to the source's name for a URL it cannot read", () => {
    expect(hostOf("not a url", "Valve relay list")).toBe("Valve relay list");
  });
});

describe("penSeed", () => {
  it("is one of the three hands, the same for a service every time", () => {
    for (const entry of CATALOG) {
      expect([0, 1, 2]).toContain(penSeed(entry.id));
      expect(penSeed(entry.id)).toBe(penSeed(entry.id));
    }
    expect(new Set(CATALOG.slice(0, 3).map((entry) => penSeed(entry.id))).size).toBe(3);
  });
});

describe("IncidentSince", () => {
  const at = "2026-09-27T10:00:00.000Z";
  const render = (props: Partial<Parameters<typeof IncidentSince>[0]>) =>
    renderToStaticMarkup(createElement(IncidentSince, { startedAt: at, reference: Date.parse(at), now: 0, ...props }));

  it("prints nothing without a readable start", () => {
    expect(render({ startedAt: undefined })).toBe("");
    expect(render({ startedAt: "yesterday-ish" })).toBe("");
  });

  it("says since and the time, with no duration before the clock is read", () => {
    const html = render({});
    expect(html).toContain("since ");
    expect(html).toContain(">10:00\u202fUTC</time>");
    expect(html).not.toContain("(");
  });

  it("adds how long it has run, in brackets, once the clock is known", () => {
    const html = render({ now: Date.parse(at) + 130 * 60_000 });
    expect(html).toContain('<time dateTime="PT2H10M">');
    expect(html).toContain(">2h\u202f10m</span>");
    expect(html).toContain(">2 hours 10 minutes</span>");
    expect(html).toMatch(/\(<time dateTime="PT2H10M"/);
  });

  it("says scheduled for a start still ahead", () => {
    const html = render({ reference: Date.parse(at) - 60_000, now: Date.parse(at) - 60_000 });
    expect(html).toContain("scheduled for ");
    expect(html).not.toContain("PT");
  });
});
