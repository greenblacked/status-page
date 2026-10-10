import type { Page } from "@playwright/test";
import { fixtureBoard } from "./fixture-board";
import { controlBar, openBoard, openWithFixture } from "./support/layout";
import { expect, test } from "./test";

// Throwaway probe: scrolls down past "Needs a look" and back up by wheel steps, logs every step, and always fails so
// the numbers reach the CI annotations.

type Step = {
  i: number;
  b: number;
  a: number;
  exp: number;
  d: number;
  h: number;
  top: Record<string, number | null>;
  ev: number;
  ls: number;
};

const STEP = 120;

async function install(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as Window & { __p?: { ev: number; ls: number; calls: string[] }; __by?: typeof scrollBy };
    w.__by = scrollBy.bind(window);
    const p = { ev: 0, ls: 0, calls: [] as string[] };
    w.__p = p;
    addEventListener("scroll", () => {
      p.ev++;
    });
    const note = (name: string) => {
      if (p.calls.length < 12)
        p.calls.push(
          `${name}@${Math.round(scrollY)}:${(new Error().stack ?? "").split("\n").slice(2, 4).join("|").replace(/\s+/g, " ").slice(0, 160)}`,
        );
    };
    for (const [obj, name] of [
      [window, "scrollTo"],
      [window, "scrollBy"],
      [Element.prototype, "scrollIntoView"],
      [HTMLElement.prototype, "focus"],
    ] as const) {
      const o = obj as unknown as Record<string, (...a: unknown[]) => unknown>;
      const orig = o[name];
      o[name] = function (this: unknown, ...a: unknown[]) {
        note(name);
        return orig.apply(this, a);
      };
    }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) p.ls += (e as unknown as { value: number }).value;
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      // not supported
    }
  });
}

const frame = (page: Page) =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const read = (page: Page) =>
  page.evaluate(() => {
    const top = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top * 10) / 10 : null;
    };
    const p = (window as Window & { __p?: { ev: number; ls: number } }).__p;
    return {
      y: Math.round(scrollY * 10) / 10,
      h: document.scrollingElement?.scrollHeight ?? 0,
      top: {
        main: top("main"),
        hero: top("header"),
        search: top('[data-search-input="hero"]'),
        att: top('[data-group="attention"]'),
        bar: top('section[aria-label="Board controls"]'),
      },
      ev: p?.ev ?? 0,
      ls: Math.round((p?.ls ?? 0) * 1000) / 1000,
    };
  });

async function idle(page: Page): Promise<void> {
  for (let last = -1, n = 0; n < 3; ) {
    await frame(page);
    const y = await page.evaluate(() => scrollY);
    n = y === last ? n + 1 : 0;
    last = y;
  }
}

let wheelWorks = true;

/** A wheel step; mobile WebKit has no mouse wheel, so there the page is scrolled by script (the native scrollBy, unlogged). */
async function step(page: Page, dy: number): Promise<void> {
  if (wheelWorks) {
    try {
      await page.mouse.wheel(0, dy);
      return;
    } catch {
      wheelWorks = false;
    }
  }
  await page.evaluate((by) => (window as Window & { __by?: typeof scrollBy }).__by?.(0, by), dy);
}

async function probe(page: Page, label: string): Promise<void> {
  const project = test.info().project.name;
  wheelWorks = true;
  await expect(controlBar(page)).toBeAttached();
  await install(page);
  const vp = page.viewportSize() ?? { width: 0, height: 0 };
  await page.mouse.move(vp.width / 2, vp.height / 2);
  const target = await page.evaluate(() => {
    const att = document.querySelector('[data-group="attention"]');
    const bottom = att ? att.getBoundingClientRect().bottom + scrollY : 0;
    return bottom + 2 * innerHeight;
  });
  const max = await page.evaluate(() => (document.scrollingElement?.scrollHeight ?? 0) - innerHeight);
  const goal = Math.min(target, max);
  for (let guard = 0; guard < 200 && (await page.evaluate(() => scrollY)) < goal - 1; guard++) {
    await step(page, STEP);
    await frame(page);
  }
  await idle(page);
  const steps: Step[] = [];
  const downTo = await read(page);
  for (let i = 0; i < 200; i++) {
    const before = await read(page);
    if (before.y <= 0) break;
    const exp = -Math.min(STEP, before.y);
    await step(page, -STEP);
    await frame(page);
    const after = await read(page);
    steps.push({
      i,
      b: before.y,
      a: after.y,
      exp,
      d: Math.round((after.y - before.y - exp) * 10) / 10,
      h: after.h,
      top: after.top,
      ev: after.ev,
      ls: after.ls,
    });
    // a wheel that moved nothing at all: let it settle once before giving up
    if (after.y === before.y) {
      await idle(page);
      if ((await read(page)).y === before.y) break;
    }
  }
  await idle(page);
  const end = await read(page);
  const calls = await page.evaluate(() => (window as Window & { __p?: { calls: string[] } }).__p?.calls ?? []);
  const anomalies: unknown[] = [];
  steps.forEach((s, k) => {
    const prev = k > 0 ? steps[k - 1] : undefined;
    const hChanged = prev ? Math.abs(s.h - prev.h) > 2 : false;
    if (Math.abs(s.d) > 4 || hChanged)
      anomalies.push({ i: s.i, b: s.b, a: s.a, d: s.d, h: s.h, ph: prev?.h, top: s.top });
  });
  const worst = [...steps]
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
    .slice(0, 5)
    .map((s) => ({ i: s.i, b: s.b, a: s.a, d: s.d, h: s.h, top: s.top }));
  const out = {
    project,
    label,
    wheel: wheelWorks,
    vp,
    downTo: { y: downTo.y, h: downTo.h, top: downTo.top },
    n: steps.length,
    end: end.y,
    anomalies: anomalies.slice(0, 6),
    nAnom: anomalies.length,
    firstFrames: steps.slice(0, 5).map((s) => ({ b: s.b, a: s.a, d: s.d, h: s.h, ev: s.ev, ls: s.ls, top: s.top })),
    worst,
    calls: calls.slice(0, 6),
  };
  let json = JSON.stringify(out);
  if (json.length > 3500)
    json = JSON.stringify({
      ...out,
      firstFrames: out.firstFrames.slice(0, 3),
      worst: out.worst.slice(0, 3),
      calls: out.calls.slice(0, 3),
    });
  expect(json.slice(0, 3600)).toBe("");
}

test.describe("probe: scroll up on a phone", { tag: "@layout" }, () => {
  test("default first render", async ({ page }) => {
    await openBoard(page, "quiet");
    await probe(page, "default");
  });

  test("fixture board after Refresh", async ({ page }) => {
    const refresh = await openWithFixture(page, "quiet", fixtureBoard);
    await refresh();
    await probe(page, "fixture");
  });
});
