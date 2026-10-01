import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateFeed } from "@/components/status/update-feed";
import { FEED_RESERVE_PROPERTY, FEED_RESERVE_SCRIPT } from "./feed-reserve";
import { PULSE_STORAGE_KEY, type Pulse } from "./pulse";
import { RECENT_LIMIT } from "./recent";
import { lastPulseAt } from "./schedule";

const NOW = Date.parse("2026-09-30T10:01:00.000Z");
const SLOT = lastPulseAt(NOW);
const counts = { operational: 14, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function pulse(n: number, over: Partial<Pulse> = {}): Pulse {
  const slot = SLOT - n * 120_000;
  return {
    slot,
    at: new Date(slot).toISOString(),
    overall: "operational",
    counts,
    changes: [],
    opening: false,
    ...over,
  };
}

const down = { id: "aws" as const, name: "AWS", from: "operational" as const, to: "outage" as const, summary: "Down" };
const long = "Increased error rates and latency for API requests in US-EAST-1 affecting several services";
const many = [
  { ...down, id: "gcp" as const, name: "Google Cloud", to: "degraded" as const, summary: "Slow" },
  { ...down, name: "Amazon Web Services", summary: long },
  { ...down, id: "android" as const, name: "Android / Play", to: "maintenance" as const, summary: "Planned" },
];
const busy = { operational: 10, degraded: 2, outage: 1, maintenance: 1, unknown: 0 };

const shapes: Record<string, Pulse[]> = {
  "one opening check": [pulse(0, { opening: true })],
  "single changes": Array.from({ length: 12 }, (_, n) => pulse(n, { changes: [down] })),
  "quiet runs between changes": [
    pulse(0, { changes: [down] }),
    pulse(1),
    pulse(2),
    pulse(3),
    pulse(4, { changes: [down] }),
    pulse(5),
    pulse(6),
  ],
  "all quiet": Array.from({ length: 20 }, (_, n) => pulse(n)),
  "the limit applies to checks, before they are merged": [
    ...Array.from({ length: RECENT_LIMIT }, (_, n) => pulse(n)),
    pulse(RECENT_LIMIT, { changes: [down] }),
  ],
  "realistic: several services, long summaries, a quiet run": [
    pulse(0, { counts: busy, changes: many }),
    pulse(1, { counts: busy, changes: [many[1]] }),
    pulse(2, { counts: busy, changes: [{ ...down, name: "MikroTik RouterOS", summary: long }] }),
    pulse(3, { counts: busy, changes: [{ ...down, to: "operational", summary: "" }] }),
    pulse(4, { counts: busy }),
    pulse(5, { counts: busy }),
    pulse(6, { counts: busy, changes: [{ ...down, from: "degraded", to: "unknown", summary: "" }] }),
    pulse(7, { counts: busy, changes: [{ ...down, from: "outage", to: "outage", summary: "Release 7.21 stable" }] }),
    pulse(8, { counts: busy, changes: many }),
  ],
};

/** Just enough of the DOM for the script: elements that nest, carry a class and text, and can be measured. */
class FakeElement {
  className = "";
  textContent = "";
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  readonly props = new Map<string, string>();
  readonly style = { setProperty: (name: string, value: string) => void this.props.set(name, value) };
  constructor(
    readonly tag: string,
    private readonly measure: (node: FakeElement) => number = () => 0,
  ) {}
  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
  }
  insertBefore(child: FakeElement, before: FakeElement | null) {
    child.parentNode = this;
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
  }
  removeChild(child: FakeElement) {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
  }
  /** Set to `ol` once the real rows are drawn in the element. */
  drawn = false;
  querySelector(selector: string): FakeElement | null {
    return selector === "ol" && this.drawn ? this : null;
  }
  get nextSibling(): FakeElement | null {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get previousElementSibling(): FakeElement | null {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  get offsetHeight(): number {
    return this.measure(this);
  }
}

/** The element as the structure a person would compare: tag, class and text, children inside. */
function outline(node: FakeElement): string {
  const cls = node.className ? ` class="${node.className}"` : "";
  return `<${node.tag}${cls}>${node.textContent}${node.children.map(outline).join("")}</${node.tag}>`;
}

type Run = { property: string | null; measured: string | null; ran: boolean };

/** Runs the script as text, as the page does, against stand-ins; the measuring copy reports `height`. */
function run(stored: string | null | (() => string | null), height = 321): Run {
  let measured: string | null = null;
  const surface = new FakeElement("div");
  surface.className = "surface spotlight card-list min-h-[var(--feed-reserve,0px)]";
  const script = new FakeElement("script");
  const parent = new FakeElement("div");
  parent.appendChild(surface);
  parent.appendChild(script);
  const document = {
    currentScript: script,
    createElement: (tag: string) =>
      new FakeElement(tag, (node) => {
        measured = outline(node);
        return height;
      }),
  };
  const localStorage = {
    getItem: (key: string) => {
      expect(key).toBe(PULSE_STORAGE_KEY);
      return typeof stored === "function" ? stored() : stored;
    },
  };
  new Function("document", "localStorage", FEED_RESERVE_SCRIPT)(document, localStorage);
  // Whatever happened, the measuring copy is gone and the page is as it was.
  expect(parent.children).toEqual([surface, script]);
  return { property: surface.props.get(FEED_RESERVE_PROPERTY) ?? null, measured, ran: true };
}

const store = (pulses: unknown, lastSlot: number | null = SLOT) =>
  JSON.stringify({ lastSlot, lastBoard: null, pulses });

const decode = (text: string) =>
  text
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The rows the real feed draws, reduced to tags, classes and text, the time left out of it. */
function realOutline(pulses: Pulse[]): string {
  const html = renderToStaticMarkup(createElement(UpdateFeed, { pulses }));
  const list = html.slice(html.indexOf("<ol>"), html.indexOf("</ol>") + 5);
  return decode(
    list
      .replace(/<time [^>]*class="([^"]*)"[^>]*>[^<]*<\/time>/g, '<time class="$1">00:00 UTC</time>')
      .replace(/<(\w+)(?:\s[^>]*?class="([^"]*)"[^>]*)?>/g, (_, tag, cls) =>
        cls ? `<${tag} class="${cls}">` : `<${tag}>`,
      ),
  );
}

describe("FEED_RESERVE_SCRIPT", () => {
  it("builds the same rows, classes and words as the feed draws", () => {
    for (const [name, pulses] of Object.entries(shapes)) {
      const { measured } = run(store(pulses));
      const rows = (measured ?? "").replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "");
      expect(rows, name).toBe(realOutline(pulses));
    }
  });

  it("puts the copy in a surface with the real one's classes, measures it and sets the reserve", () => {
    const { property, measured } = run(store(shapes["single changes"]), 417);
    expect(property).toBe("417px");
    expect(measured?.startsWith('<div class="surface spotlight card-list min-h-[var(--feed-reserve,0px)]"><ol>')).toBe(
      true,
    );
  });

  it("draws at most the feed's rows", () => {
    const { measured } = run(store(shapes["single changes"]));
    expect(measured?.match(/<li>/g)).toHaveLength(RECENT_LIMIT);
  });

  it("adds the check the load makes when this slot is not saved yet, and drops the oldest", () => {
    const pulses = shapes["realistic: several services, long summaries, a quiet run"];
    const added = [pulse(-1, { counts: busy }), ...pulses];
    for (const lastSlot of [SLOT - 120_000, null]) {
      expect(run(store(pulses, lastSlot)).measured).toContain(realOutline(added));
    }
    // The saved slot is the current one: nothing is added.
    expect(run(store(pulses)).measured).toContain(realOutline(pulses));
  });

  it("merges that new quiet check into a quiet newest one", () => {
    const pulses = [pulse(0), pulse(1), pulse(2, { changes: [down] })];
    expect(run(store(pulses, SLOT - 120_000)).measured).toContain("Nothing changed · 3 checks");
  });

  it("reserves one row for a store with no checks, which the load makes the first of", () => {
    const { property, measured } = run(store([]), 65);
    expect(property).toBe("65px");
    expect(measured).toContain("Nothing changed</p><p");
  });

  it("sets nothing when there is nothing readable saved", () => {
    for (const stored of [null, "", "not json", "null", store("nope")]) expect(run(stored).property).toBeNull();
    expect(
      run(() => {
        throw new Error("blocked");
      }).property,
    ).toBeNull();
  });

  it("sets nothing when the measured height is nothing", () => {
    expect(run(store(shapes["single changes"]), 0).property).toBeNull();
  });

  it("does not throw on a malformed check", () => {
    expect(run(store([null, 3, {}, { changes: "x" }])).property).toBe("321px");
    expect(run(store([{ counts: "x", changes: [null] }, { changes: [{ summary: 1 }, {}] }])).property).toBe("321px");
  });

  it("measures again when the fonts are ready, and not once the rows are drawn", async () => {
    const heights = [100, 140, 180];
    const surface = new FakeElement("div");
    const script = new FakeElement("script");
    const parent = new FakeElement("div");
    parent.appendChild(surface);
    parent.appendChild(script);
    let ready: () => void = () => {};
    const loaded: Array<() => void> = [];
    const document = {
      currentScript: script,
      fonts: {
        ready: new Promise<void>((resolve) => {
          ready = resolve;
        }),
        addEventListener: (_type: string, done: () => void) => void loaded.push(done),
      },
      createElement: (tag: string) => new FakeElement(tag, () => heights.shift() ?? 0),
    };
    const frames: Array<() => void> = [];
    new Function("document", "localStorage", "requestAnimationFrame", FEED_RESERVE_SCRIPT)(
      document,
      { getItem: () => store([pulse(0)]) },
      (frame: () => void) => void frames.push(frame),
    );
    expect(surface.props.get(FEED_RESERVE_PROPERTY)).toBe("100px");
    // Before the first frame, the page's faces are in, and layout has moved on.
    frames[0]();
    expect(surface.props.get(FEED_RESERVE_PROPERTY)).toBe("140px");
    heights.unshift(150);
    loaded[0]();
    expect(surface.props.get(FEED_RESERVE_PROPERTY)).toBe("150px");
    // And on timers, which the fake clock here runs on demand.
    heights.unshift(160);
    vi.advanceTimersByTime(100);
    expect(surface.props.get(FEED_RESERVE_PROPERTY)).toBe("160px");
    ready();
    await document.fonts.ready;
    await Promise.resolve();
    expect(surface.props.get(FEED_RESERVE_PROPERTY)).toBe("180px");
    surface.drawn = true;
    heights.push(999);
    loaded[0]();
    frames[0]();
    expect(surface.props.get(FEED_RESERVE_PROPERTY)).toBe("180px");
    expect(parent.children).toEqual([surface, script]);
  });

  it("leaves nothing of itself on the page when it fails while measuring", () => {
    const surface = new FakeElement("div");
    const script = new FakeElement("script");
    const parent = new FakeElement("div");
    parent.appendChild(surface);
    parent.appendChild(script);
    const document = {
      currentScript: script,
      createElement: (tag: string) =>
        new FakeElement(tag, () => {
          throw new Error("no layout");
        }),
    };
    expect(() =>
      new Function("document", "localStorage", FEED_RESERVE_SCRIPT)(document, { getItem: () => store([pulse(0)]) }),
    ).not.toThrow();
    expect(parent.children).toEqual([surface, script]);
    expect(surface.props.size).toBe(0);
  });

  it("does nothing without a surface before it", () => {
    const script = new FakeElement("script");
    new FakeElement("div").appendChild(script);
    expect(() =>
      new Function("document", "localStorage", FEED_RESERVE_SCRIPT)(
        { currentScript: script, createElement: () => new FakeElement("div") },
        { getItem: () => store([pulse(0)]) },
      ),
    ).not.toThrow();
  });
});
