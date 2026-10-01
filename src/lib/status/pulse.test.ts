import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { board, service } from "../../test/fixtures.ts";
import { emptyPulseStore, loadPulseStore, type Pulse, parsePulseStore, syncPulse } from "./pulse.ts";
import type { BoardSnapshot, Health } from "./types.ts";

function snapshot(at: string, health: Health): BoardSnapshot {
  return board(
    [
      service("aws", {
        name: "Amazon Web Services",
        health,
        summary: health === "operational" ? "clear" : "impact",
        checkedAt: at,
      }),
    ],
    { generatedAt: at },
  );
}

describe("syncPulse", () => {
  it("records an opening snapshot, then a 2-minute diff", () => {
    const noon = Date.parse("2026-09-22T12:00:00.000Z");
    const first = snapshot("2026-09-22T12:00:00.000Z", "operational");
    const opened = syncPulse(first, noon + 1_000, emptyPulseStore());
    assert.equal(opened.pulses.length, 1);
    assert.equal(opened.pulses[0]?.opening, true);
    assert.equal(opened.pulses[0]?.changes.length, 0);

    const sameSlot = syncPulse(first, noon + 30_000, opened);
    assert.equal(sameSlot.lastBoard, first);
    assert.equal(sameSlot.pulses.length, 1);

    const later = snapshot("2026-09-22T12:02:10.000Z", "degraded");
    const pulsed = syncPulse(later, noon + 2 * 60 * 1000 + 2_000, opened);
    assert.equal(pulsed.pulses.length, 2);
    assert.equal(pulsed.pulses[0]?.opening, false);
    assert.deepEqual(pulsed.pulses[0]?.changes, [
      {
        id: "aws",
        name: "Amazon Web Services",
        from: "operational",
        to: "degraded",
        summary: "impact",
      },
    ]);
  });

  it("posts a new release even inside the current 2-minute slot", () => {
    const noon = Date.parse("2026-09-22T12:00:00.000Z");
    const mikrotik = (version: string): BoardSnapshot =>
      board(
        [
          service("mikrotik", {
            name: "MikroTik RouterOS",
            summary: `Latest RouterOS ${version}`,
            meta: { latest: version, versions: `RouterOS 7 stable=${version}` },
          }),
        ],
        { generatedAt: "2026-09-22T12:00:00.000Z" },
      );
    const opened = syncPulse(mikrotik("7.24.4"), noon + 1_000, emptyPulseStore());
    const posted = syncPulse(mikrotik("7.24.5"), noon + 20_000, opened);
    assert.equal(posted.pulses.length, 1);
    assert.equal(posted.pulses[0]?.opening, false);
    assert.equal(posted.pulses[0]?.changes[0]?.summary, "RouterOS 7 stable 7.24.5");
  });
});

describe("loading the pulse store from storage", () => {
  const NOON = Date.parse("2026-09-22T12:00:00.000Z");
  const counts = { operational: 1, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
  const pulse = (slot: number, overrides: Record<string, unknown> = {}) => ({
    slot,
    at: "2026-09-22T12:00:00.000Z",
    overall: "operational",
    counts,
    changes: [],
    opening: false,
    ...overrides,
  });
  const change = { id: "aws", name: "Amazon Web Services", from: "operational", to: "degraded", summary: "impact" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stored(value: unknown) {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "status-bar:pulses:v2" ? JSON.stringify(value) : null),
    });
  }

  it("round-trips a store that syncPulse wrote, unchanged", () => {
    const first = syncPulse(snapshot("2026-09-22T12:00:00.000Z", "operational"), NOON + 1_000, emptyPulseStore());
    const second = syncPulse(snapshot("2026-09-22T12:02:10.000Z", "degraded"), NOON + 125_000, first);
    stored(second);
    assert.deepEqual(loadPulseStore(), JSON.parse(JSON.stringify(second)));
  });

  it("resets a value that is not a store", () => {
    for (const value of [null, 7, "x", [], true, {}, { pulses: null }, { pulses: {} }, { pulses: "x" }]) {
      stored(value);
      assert.deepEqual(loadPulseStore(), emptyPulseStore(), JSON.stringify(value));
    }
  });

  it("resets on text that is not JSON, and on missing storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => "{not json" });
    assert.deepEqual(loadPulseStore(), emptyPulseStore());
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    assert.deepEqual(loadPulseStore(), emptyPulseStore());
  });

  it("forgets a last board that is not a board, and keeps the pulses", () => {
    for (const lastBoard of [{}, [], "x", 3, null, { services: "x" }, { services: null }]) {
      const store = parsePulseStore({ lastSlot: 5, lastBoard, pulses: [pulse(5)] });
      assert.equal(store.lastBoard, null);
      assert.equal(store.lastSlot, 5);
      assert.equal(store.pulses.length, 1);
      // And the next sync, which diffs against the last board, does not throw.
      syncPulse(snapshot("2026-09-22T12:00:00.000Z", "operational"), NOON, store);
    }
  });

  it("drops services of the last board that have no id or a health that is not one", () => {
    const store = parsePulseStore({
      lastSlot: 1,
      pulses: [],
      lastBoard: {
        generatedAt: "2026-09-22T12:00:00.000Z",
        services: [
          null,
          4,
          {},
          { id: "aws" },
          { id: "aws", health: "fine" },
          { id: 3, health: "outage" },
          { id: "gcp", health: "outage" },
        ],
      },
    });
    assert.deepEqual(store.lastBoard?.services, [{ id: "gcp", health: "outage" }]);
    assert.equal(store.lastBoard?.generatedAt, "2026-09-22T12:00:00.000Z");
    // The surviving service still diffs: a recovery is reported.
    const synced = syncPulse(snapshot("2026-09-22T12:00:00.000Z", "operational"), NOON, store);
    assert.equal(synced.pulses.length, 1);
  });

  it("drops pulses that are not pulses, and keeps the rest newest first", () => {
    const store = parsePulseStore({
      lastSlot: 3,
      lastBoard: null,
      pulses: [
        null,
        7,
        "x",
        [],
        {},
        pulse(1),
        pulse(3),
        pulse(2, { slot: "2" }),
        pulse(2, { slot: Number.NaN }),
        pulse(2, { at: 5 }),
        pulse(2, { overall: "fine" }),
        pulse(2, { opening: "yes" }),
        pulse(2, { counts: null }),
        pulse(2, { counts: { operational: 1 } }),
        pulse(2, { counts: { ...counts, outage: "1" } }),
        pulse(2, { changes: null }),
        pulse(2),
      ],
    });
    assert.deepEqual(
      store.pulses.map((item) => item.slot),
      [3, 2, 1],
    );
  });

  it("drops the changes of a pulse that are not changes, and keeps the pulse", () => {
    const store = parsePulseStore({
      lastSlot: 1,
      lastBoard: null,
      pulses: [
        pulse(1, {
          changes: [
            null,
            {},
            { ...change, from: "fine" },
            { ...change, name: 4 },
            { ...change, summary: undefined },
            change,
          ],
        }),
      ],
    });
    assert.deepEqual(store.pulses[0]?.changes, [change]);
  });

  it("forgets a last slot that no longer names the newest pulse", () => {
    // The newest pulse is unreadable, so slot 3 is not the head of the list any more.
    const store = parsePulseStore({ lastSlot: 3, lastBoard: null, pulses: [pulse(3, { overall: "fine" }), pulse(2)] });
    assert.equal(store.lastSlot, null);
    assert.deepEqual(
      store.pulses.map((item) => item.slot),
      [2],
    );
    assert.equal(parsePulseStore({ lastSlot: 2, lastBoard: null, pulses: [pulse(3), pulse(2)] }).lastSlot, null);
    assert.equal(parsePulseStore({ lastSlot: 3, lastBoard: null, pulses: [pulse(3), pulse(2)] }).lastSlot, 3);
  });

  it("reads a last slot that is not a number as none, and caps the pulses at what the feed keeps", () => {
    assert.equal(parsePulseStore({ lastSlot: "5", pulses: [] }).lastSlot, null);
    assert.equal(parsePulseStore({ lastSlot: null, pulses: [] }).lastSlot, null);
    const many = Array.from({ length: 200 }, (_, i) => pulse(i));
    const kept: Pulse[] = parsePulseStore({ lastSlot: 199, pulses: many }).pulses;
    assert.equal(kept.length, 60);
    assert.equal(kept[0]?.slot, 199);
  });

  it("lets the board render after loading tampered input", () => {
    stored({ lastSlot: 1, lastBoard: {}, pulses: [null, pulse(1, { changes: [null] })] });
    const store = loadPulseStore();
    const next = syncPulse(snapshot("2026-09-22T12:00:00.000Z", "operational"), NOON, store);
    assert.ok(next.pulses.length >= 1);
  });
});
