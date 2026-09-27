import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { board, service } from "../../test/fixtures.ts";
import { emptyPulseStore, syncPulse } from "./pulse.ts";
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
