import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithCloudflareContext } from "./cloudflare-context";
import { assembleBoard, collectBoard } from "./collect-board";
import type { BoardSnapshot, ReleaseFeed, ServiceId, ServiceSnapshot } from "./types";

// collectBoard's own logic, with the sweep, the feeds and the notes stood in
// for: the release-feeds and mikrotik-notes tests drive the real ones.
const sources = vi.hoisted(() => ({ collectAllServices: vi.fn() }));
vi.mock("./sources.server", () => sources);
const feeds = vi.hoisted(() => ({ startReleaseFeeds: vi.fn(), withReleaseFeeds: vi.fn() }));
vi.mock("./release-feeds.server", () => feeds);
const notes = vi.hoisted(() => ({ startMikrotikNotes: vi.fn(), withMikrotikNotes: vi.fn() }));
vi.mock("./mikrotik-notes.server", () => notes);

function service(overrides: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    id: "gcp",
    name: "Google Cloud",
    shortName: "GCP",
    category: "cloud",
    health: "operational",
    summary: "",
    sourceName: "Google Cloud Status",
    sourceUrl: "https://status.cloud.google.com",
    checkedAt: "2026-09-27T00:00:00.000Z",
    latencyMs: 10,
    components: [],
    incidents: [],
    ...overrides,
  };
}

describe("assembleBoard", () => {
  it("counts services by health and stamps a generation time", () => {
    const before = Date.now();
    const board = assembleBoard(
      [
        service({ health: "operational" }),
        service({ id: "aws", health: "outage" }),
        service({ id: "epic", health: "operational" }),
      ],
      250,
    );
    const after = Date.now();

    expect(board.durationMs).toBe(250);
    expect(board.services).toHaveLength(3);
    expect(board.counts).toEqual({ operational: 2, degraded: 0, outage: 1, maintenance: 0, unknown: 0 });
    expect(Date.parse(board.generatedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(board.generatedAt)).toBeLessThanOrEqual(after);
  });

  it("counts every health state, including empty input", () => {
    const board = assembleBoard([], 0);
    expect(board.counts).toEqual({ operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 });
  });
});

describe("collectBoard and what arrives after it", () => {
  const feed: ReleaseFeed = {
    sourceName: "GitLab releases",
    sourceUrl: "https://docs.gitlab.com/releases/",
    entries: [{ title: "GitLab 18.4", release: { version: "18.4", releasedAt: "2026-09-18T00:00:00.000Z" } }],
  };
  const newer: ReleaseFeed = { ...feed, entries: [{ ...feed.entries[0], title: "GitLab 18.5" }] };

  /** The feeds of one board build: some in hand at the start, more landing when the test says. */
  function reading(initial: Array<[ServiceId, ReleaseFeed]> = []) {
    const inHand = new Map<ServiceId, ReleaseFeed>(initial);
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => (settle = resolve));
    feeds.startReleaseFeeds.mockReturnValueOnce({ ready: () => new Map(inHand), settled });
    return {
      land: (id: ServiceId, value: ReleaseFeed) => inHand.set(id, value),
      settle: () => settle(),
    };
  }

  let notesKnown = false;
  beforeEach(() => {
    notesKnown = false;
    sources.collectAllServices.mockResolvedValue([
      service({ id: "gitlab", health: "degraded" }),
      service({ id: "mikrotik", category: "updates", summary: "Latest RouterOS 7.20.2" }),
    ]);
    feeds.withReleaseFeeds.mockImplementation((services: ServiceSnapshot[], map: Map<ServiceId, ReleaseFeed>) =>
      services.map((card) => (map.has(card.id) ? { ...card, releaseFeed: map.get(card.id) } : card)),
    );
    notes.startMikrotikNotes.mockResolvedValue(0);
    notes.withMikrotikNotes.mockImplementation((services: ServiceSnapshot[]) =>
      services.map((card) =>
        card.id === "mikrotik" && notesKnown ? { ...card, summary: "What's new in 7.21" } : card,
      ),
    );
  });
  afterEach(() => {
    vi.resetAllMocks();
  });

  /** Builds a board, handing waitUntil's promise back so a test can wait for the late part. */
  async function build(onLate: (patch: (board: BoardSnapshot) => BoardSnapshot) => void) {
    const waiting: Promise<unknown>[] = [];
    const board = await runWithCloudflareContext({ env: {}, waitUntil: (promise) => waiting.push(promise) }, () =>
      collectBoard({ onLate }),
    );
    expect(waiting).toHaveLength(1);
    return { board, late: waiting[0] };
  }

  it("hands over one patch when a feed lands after the board went out, which changes no health or count", async () => {
    const feedsOfBuild = reading();
    const onLate = vi.fn();
    const { board, late } = await build(onLate);
    expect(board.services.find((card) => card.id === "gitlab")?.releaseFeed).toBeUndefined();

    feedsOfBuild.land("gitlab", feed);
    feedsOfBuild.settle();
    await late;

    expect(onLate).toHaveBeenCalledOnce();
    const patched = onLate.mock.calls[0][0](board);
    expect(patched.services.find((card: ServiceSnapshot) => card.id === "gitlab")?.releaseFeed).toEqual(feed);
    expect({ ...patched, services: [] }).toEqual({ ...board, services: [] });
    expect(patched.services.map((card: ServiceSnapshot) => card.health)).toEqual(board.services.map((c) => c.health));
  });

  it("hands over a patch when a feed in hand was replaced by a newer read", async () => {
    const feedsOfBuild = reading([["gitlab", feed]]);
    const onLate = vi.fn();
    const { board, late } = await build(onLate);

    feedsOfBuild.land("gitlab", newer);
    feedsOfBuild.settle();
    await late;

    expect(onLate).toHaveBeenCalledOnce();
    expect(onLate.mock.calls[0][0](board).services[0].releaseFeed).toEqual(newer);
  });

  it("hands over a patch when MikroTik notes were read after the board went out", async () => {
    reading().settle();
    notes.startMikrotikNotes.mockImplementationOnce(async () => {
      notesKnown = true;
      return 2;
    });
    const onLate = vi.fn();
    const { board, late } = await build(onLate);
    expect(board.services[1].summary).toBe("Latest RouterOS 7.20.2");
    await late;

    expect(onLate).toHaveBeenCalledOnce();
    const patched = onLate.mock.calls[0][0](board);
    expect(patched.services[1].summary).toBe("What's new in 7.21");
    expect(patched.generatedAt).toBe(board.generatedAt);
    expect(patched.counts).toEqual(board.counts);
  });

  it("hands over nothing when nothing new arrived", async () => {
    reading([["gitlab", feed]]).settle();
    const onLate = vi.fn();
    const { late } = await build(onLate);
    await late;

    expect(onLate).not.toHaveBeenCalled();
  });

  it("patches only the board it was built for, not a later one", async () => {
    const feedsOfBuild = reading();
    const onLate = vi.fn();
    const { board, late } = await build(onLate);
    feedsOfBuild.land("gitlab", feed);
    feedsOfBuild.settle();
    await late;

    const later = { ...board, generatedAt: "2099-01-01T00:00:00.000Z" };
    expect(onLate.mock.calls[0][0](later)).toBe(later);
  });

  it("never rejects in the background, on a Worker or not, whatever the notes do", async () => {
    reading().settle();
    notes.startMikrotikNotes.mockRejectedValueOnce(new Error("notes broke"));
    const onLate = vi.fn();
    const { late } = await build(onLate);
    await expect(late).resolves.toBeUndefined();
    expect(onLate).not.toHaveBeenCalled();

    // Outside a Worker nothing awaits the late part: a rejection there would be unhandled.
    reading().settle();
    notes.startMikrotikNotes.mockRejectedValueOnce(new Error("notes broke"));
    await collectBoard({ onLate });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onLate).not.toHaveBeenCalled();
  });
});
