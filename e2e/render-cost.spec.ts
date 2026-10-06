import type { Page } from "@playwright/test";
import { fixtureBoard, serveBoard } from "./fixture-board";
import { expect, test } from "./test";

// The board used to render again every second: one clock at the top of the page ticked, and every card, section
// and the floating bar rendered with it, for a countdown that only the live line (and, from 640px, the bar) shows.
// These tests count what React renders, from the page's own commits, and what the clocks show.

const SERVICES = 20;
const SLOT_MS = 120_000;

type RenderLog = { commits: number; cards: number; ids: string[] };

/**
 * Hooks into React the way its developer tools do (the hook it looks for on `window`; the production build
 * reports to it as well) and, on every commit, counts the card components that rendered in it. A fiber that bailed
 * out has no `PerformedWork` flag, and a subtree that bailed out is not entered, so a card that React skipped is
 * not counted, whatever its parents did. A card is a component given a `service` (ServiceCard and the shape it
 * picks).
 */
async function countCardRenders(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const PERFORMED_WORK = 1;
    const log: RenderLog = { commits: 0, cards: 0, ids: [] };
    (window as Window & { __renders?: RenderLog }).__renders = log;
    type Fiber = {
      tag: number;
      flags: number;
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
      memoizedProps: { service?: { id?: string } } | null;
    };
    // The cards that rendered in the commit being walked, each counted once (a card is a few components deep).
    let rendered = new Set<string>();
    const visit = (next: Fiber, prev: Fiber | null) => {
      const service = next.memoizedProps?.service;
      const component = next.tag === 0 || next.tag === 14 || next.tag === 15;
      if (component && service && typeof service.id === "string" && (!prev || next.flags & PERFORMED_WORK)) {
        rendered.add(service.id);
      }
      // A child pointer that is the same as before means the whole subtree was left alone.
      if (prev && next.child === prev.child) return;
      for (let child = next.child; child; child = child.sibling) visit(child, child.alternate);
    };
    const hook = {
      supportsFiber: true,
      renderers: new Map(),
      inject(renderer: unknown) {
        this.renderers.set(this.renderers.size + 1, renderer);
        return this.renderers.size;
      },
      onCommitFiberRoot(_id: number, root: { current: Fiber }) {
        log.commits += 1;
        rendered = new Set();
        visit(root.current, root.current.alternate);
        log.cards += rendered.size;
        log.ids.push(...rendered);
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      onScheduleFiberRoot() {},
      checkDCE() {},
    };
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { value: hook, configurable: true });
  });
}

const renders = (page: Page) =>
  page.evaluate(() => {
    const log = (window as Window & { __renders?: RenderLog }).__renders;
    return { commits: log?.commits ?? 0, cards: log?.cards ?? 0, ids: log?.ids.slice() ?? [] };
  });

// Every test here sets the page's time itself (page.clock, see openSteady), so none is pinned to a slot first.
test.use({ pinSlot: false });

/** "1:52" in the live line, as seconds. */
const liveLineSeconds = async (page: Page) => {
  const text = (await page.getByTestId("live-bar").textContent()) ?? "";
  const match = /next in (\d+):(\d{2})/.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
};

async function openSteady(page: Page): Promise<void> {
  // 31 s into a slot: the slot's refetch (at most 30 s in) has gone by and the next is 105 s away, and so is the
  // minute, so nothing but the clocks is due in the few seconds the test looks.
  const slotStart = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
  await page.clock.install({ time: slotStart + 31_000 });
  const board = fixtureBoard(Date.now());
  await serveBoard(page, () => board);
  await page.goto("/");
  await expect(page.locator('article[id^="service-"]')).toHaveCount(SERVICES);
  // data-hydrated waits for the saved checks, a few renders after the first: 15 s on a loaded runner, as in board.spec.ts.
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "", { timeout: 15_000 });
  const refresh = page.getByRole("button", { name: "Refresh status now" }).first();
  await refresh.click();
  await expect(page.locator("#service-aws").getByText("Outage", { exact: true }).first()).toBeVisible();
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(page.getByTestId("live-bar")).toContainText(/next in \d+:\d{2}/);
}

test("renders no card for a tick of the seconds clock, and still counts the seconds down", async ({
  page,
  browserName,
}) => {
  await countCardRenders(page);
  await openSteady(page);
  // Let the glide of the refresh, and whatever followed it, finish.
  await page.waitForTimeout(800);
  // Chromium counts the time the page spends on script, style and layout; a tick that renders the board shows here.
  const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : undefined;
  await cdp?.send("Performance.enable");
  const busy = async () => {
    const { metrics } = (await cdp?.send("Performance.getMetrics")) ?? { metrics: [] };
    const total = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0;
    return total("ScriptDuration") + total("LayoutDuration") + total("RecalcStyleDuration");
  };
  const before = await renders(page);
  const busyBefore = await busy();
  const secondsBefore = await liveLineSeconds(page);
  await page.waitForTimeout(4_500);
  const after = await renders(page);
  const busyAfter = await busy();
  const secondsAfter = await liveLineSeconds(page);
  console.log(
    `${after.commits - before.commits} commits and ${after.cards - before.cards} card renders in 4.5 s, ${Math.round((busyAfter - busyBefore) * 1000)} ms of script, style and layout; the live line went from ${secondsBefore} to ${secondsAfter}`,
  );
  // The seconds do move: the live line is a leaf with a clock of its own.
  expect(secondsBefore - secondsAfter).toBeGreaterThanOrEqual(3);
  expect(secondsBefore - secondsAfter).toBeLessThanOrEqual(6);
  // And nothing else renders for them.
  expect(after.commits - before.commits, "something renders for the clocks").toBeGreaterThan(0);
  expect(after.cards - before.cards, `cards rendered: ${after.ids.slice(before.ids.length).join(", ")}`).toBe(0);
});

test("floating bar: its countdown ticks each second from 640px and not on a phone", async ({ page }) => {
  await openSteady(page);
  await page.waitForTimeout(500);
  const lead = page.locator("[data-bar-lead]");
  const wide = (page.viewportSize()?.width ?? 0) >= 640;
  const changes = await lead.evaluate(async (element) => {
    let count = 0;
    const observer = new MutationObserver((records) => {
      count += records.length;
    });
    observer.observe(element, { childList: true, characterData: true, subtree: true });
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    observer.disconnect();
    return count;
  });
  console.log(`the bar's lead text changed ${changes} times in 4.5 s (${wide ? "on screen" : "for screen readers"})`);
  if (wide) expect(changes).toBeGreaterThanOrEqual(3);
  // A phone's copy is for screen readers, and it moves every ten seconds: at most once in this window.
  else expect(changes).toBeLessThanOrEqual(1);
});

test("floating bar: no live region announces the countdown", async ({ page }) => {
  await openSteady(page);
  // The one polite region of the live line holds the state word and nothing that ticks; the bar has none.
  const regions = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[aria-live]"), (region) => ({
      inBar: region.closest("[data-bar-lead], section[aria-label='Board controls']") !== null,
      text: region.textContent ?? "",
    })),
  );
  expect(regions.filter((region) => region.inBar)).toEqual([]);
  expect(regions.filter((region) => /\d+:\d{2}/.test(region.text))).toEqual([]);
});
