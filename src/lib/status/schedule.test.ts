import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  formatAge,
  formatCountdown,
  formatDuration,
  formatStaleAge,
  formatUtcTime,
  incidentStart,
  isStale,
  lastPulseAt,
  nextPulseAt,
  nextRefetchAt,
  noteSnapshot,
  parseTimestamp,
  pickRefetchJitter,
  PULSE_INTERVAL_MS,
  pulseProgress,
  REFETCH_JITTER_MAX_MS,
  REFETCH_JITTER_MIN_MS,
  STALE_AFTER_MS,
} from "./schedule.ts";

describe("pulse schedule", () => {
  it("aligns slots to 2-minute walls", () => {
    const noon = Date.parse("2026-09-22T12:00:00.000Z");
    const twelveOhOne = noon + 60 * 1000;
    assert.equal(lastPulseAt(twelveOhOne), noon);
    assert.equal(nextPulseAt(twelveOhOne), noon + PULSE_INTERVAL_MS);
    assert.equal(nextPulseAt(noon), noon + PULSE_INTERVAL_MS);
    assert.equal(lastPulseAt(noon + 3 * 60 * 1000), noon + PULSE_INTERVAL_MS);
  });

  it("tracks progress through the current slot", () => {
    const noon = Date.parse("2026-09-22T12:00:00.000Z");
    assert.equal(pulseProgress(noon), 0);
    assert.equal(pulseProgress(noon + PULSE_INTERVAL_MS / 2), 0.5);
  });

  it("formats countdown and relative age", () => {
    assert.equal(formatCountdown(4 * 60 * 1000 + 2_000), "4:02");
    assert.equal(formatCountdown(500), "0:01");
    assert.equal(formatAge(4_000), "just now");
    assert.equal(formatAge(23_000), "23s ago");
    assert.equal(formatAge(3 * 60 * 1000), "3m ago");
  });
});

describe("refetch schedule", () => {
  const noon = Date.parse("2026-09-22T12:00:00.000Z");

  it("picks a jitter inside the window", () => {
    assert.equal(pickRefetchJitter(() => 0), REFETCH_JITTER_MIN_MS);
    assert.ok(pickRefetchJitter(() => 0.999_999) < REFETCH_JITTER_MAX_MS);
    for (let i = 0; i < 100; i += 1) {
      const jitter = pickRefetchJitter();
      assert.ok(jitter >= REFETCH_JITTER_MIN_MS && jitter < REFETCH_JITTER_MAX_MS);
    }
  });

  it("lands the jitter past the current slot while it is still ahead", () => {
    assert.equal(nextRefetchAt(noon, 10_000), noon + 10_000);
    assert.equal(nextRefetchAt(noon + 3_000, 10_000), noon + 10_000);
  });

  it("moves to the next slot once this slot's moment has passed", () => {
    assert.equal(nextRefetchAt(noon + 10_000, 10_000), noon + PULSE_INTERVAL_MS + 10_000);
    assert.equal(nextRefetchAt(noon + 60_000, 10_000), noon + PULSE_INTERVAL_MS + 10_000);
    assert.equal(nextRefetchAt(noon + PULSE_INTERVAL_MS - 1, 5_000), noon + PULSE_INTERVAL_MS + 5_000);
  });

  it("is always ahead of now and at most one slot away", () => {
    for (let now = noon; now < noon + 2 * PULSE_INTERVAL_MS; now += 1_000) {
      const at = nextRefetchAt(now, 12_345);
      assert.ok(at > now && at - now <= PULSE_INTERVAL_MS);
      assert.equal((at - 12_345) % PULSE_INTERVAL_MS, 0);
    }
  });
});

describe("stale snapshots", () => {
  const generatedAt = "2026-09-22T12:00:00.000Z";
  const at = Date.parse(generatedAt);

  it("turns stale after three slots without a new snapshot", () => {
    assert.equal(STALE_AFTER_MS, 3 * PULSE_INTERVAL_MS);
    assert.equal(isStale(at, at + 90_000), false);
    assert.equal(isStale(at, at + STALE_AFTER_MS), false);
    assert.equal(isStale(at, at + STALE_AFTER_MS + 1), true);
  });

  it("claims nothing before mount", () => {
    assert.equal(isStale(at, 0), false);
    assert.equal(isStale(0, at), false);
    assert.equal(noteSnapshot(null, generatedAt, 0), null);
  });

  it("times a snapshot from when this browser first showed it", () => {
    const seen = noteSnapshot(null, generatedAt, at + 30_000);
    assert.deepEqual(seen, { generatedAt, seenAt: at + 30_000 });
    // The same snapshot again keeps its first sighting.
    assert.equal(noteSnapshot(seen, generatedAt, at + 150_000), seen);
    const next = "2026-09-22T12:02:00.000Z";
    assert.deepEqual(noteSnapshot(seen, next, at + 150_000), { generatedAt: next, seenAt: at + 150_000 });
  });

  it("ignores a snapshot older than the one on screen", () => {
    const seen = noteSnapshot(null, generatedAt, at);
    assert.equal(noteSnapshot(seen, "2026-09-22T11:58:00.000Z", at + 60_000), seen);
    // Unreadable times cannot be ordered, so any change counts.
    assert.equal(noteSnapshot(seen, "garbage", at + 60_000)?.seenAt, at + 60_000);
  });

  it("is not fooled by a browser clock seven minutes ahead", () => {
    const skew = 7 * 60_000;
    // The browser reads 12:07 when the server's 12:00 snapshot arrives.
    const seen = noteSnapshot(null, generatedAt, at + skew);
    assert.equal(isStale(seen?.seenAt ?? 0, at + skew + 60_000), false);
    // Snapshots keep coming, each two minutes behind the browser's clock.
    let current = seen;
    for (let slot = 1; slot <= 10; slot += 1) {
      const next = new Date(at + slot * PULSE_INTERVAL_MS).toISOString();
      const clientNow = at + skew + slot * PULSE_INTERVAL_MS + 20_000;
      current = noteSnapshot(current, next, clientNow);
      assert.equal(isStale(current?.seenAt ?? 0, clientNow + 60_000), false);
    }
    // Then they stop.
    assert.equal(isStale(current?.seenAt ?? 0, (current?.seenAt ?? 0) + STALE_AFTER_MS + 1), true);
  });

  it("says the age in words", () => {
    assert.equal(formatStaleAge(7 * 60_000 + 30_000), "7 min ago");
    assert.equal(formatStaleAge(60 * 60_000), "1 hour ago");
    assert.equal(formatStaleAge(5 * 60 * 60_000), "5 hours ago");
    assert.equal(formatStaleAge(72 * 60 * 60_000), "3 days ago");
  });
});

describe("incident times", () => {
  it("parses vendor timestamps and rejects unreadable ones", () => {
    assert.equal(parseTimestamp("2026-09-22T12:05:00Z"), Date.parse("2026-09-22T12:05:00Z"));
    assert.equal(parseTimestamp("Tue, 22 Sep 2026 12:05:00 GMT"), Date.parse("2026-09-22T12:05:00Z"));
    assert.equal(parseTimestamp("not a date"), null);
    assert.equal(parseTimestamp(""), null);
    assert.equal(parseTimestamp(undefined), null);
  });

  it("formats a start as UTC clock time, adding the date only when it differs", () => {
    const at = Date.parse("2026-09-22T09:05:00Z");
    assert.equal(formatUtcTime(at), "09:05 UTC");
    assert.equal(formatUtcTime(at, Date.parse("2026-09-22T23:59:00Z")), "09:05 UTC");
    assert.equal(formatUtcTime(at, Date.parse("2026-09-24T01:00:00Z")), "22 Sep 09:05 UTC");
    assert.equal(formatUtcTime(at, Date.parse("2027-01-02T01:00:00Z")), "22 Sep 2026 09:05 UTC");
  });

  it("formats how long an incident has lasted", () => {
    const minute = 60_000;
    assert.deepEqual(formatDuration(20_000), { short: "under 1m", long: "under a minute", iso: "PT0H0M" });
    assert.equal(formatDuration(-5 * minute), null);
    assert.equal(formatDuration(-1), null);
    assert.equal(formatDuration(Number.NaN), null);
    assert.deepEqual(formatDuration(45 * minute), { short: "45m", long: "45 minutes", iso: "PT0H45M" });
    assert.deepEqual(formatDuration(130 * minute), { short: "2h 10m", long: "2 hours 10 minutes", iso: "PT2H10M" });
    assert.deepEqual(formatDuration(60 * minute), { short: "1h", long: "1 hour", iso: "PT1H0M" });
    assert.deepEqual(formatDuration((76 * 60 + 1) * minute), {
      short: "3d 4h",
      long: "3 days 4 hours",
      iso: "PT76H1M",
    });
    assert.deepEqual(formatDuration(48 * 60 * minute), { short: "2d", long: "2 days", iso: "PT48H0M" });
  });

  it("words a start still ahead as scheduled, with no duration", () => {
    const checkedAt = Date.parse("2026-09-22T14:00:00Z");
    const later = Date.parse("2026-09-22T22:00:00Z");
    const earlier = Date.parse("2026-09-22T12:00:00Z");
    assert.deepEqual(incidentStart(later, checkedAt + 60_000, checkedAt), { upcoming: true, duration: null });
    assert.deepEqual(incidentStart(earlier, checkedAt, checkedAt), {
      upcoming: false,
      duration: { short: "2h", long: "2 hours", iso: "PT2H0M" },
    });
    // Once it begins, it runs.
    assert.equal(incidentStart(later, later + 5 * 60_000, checkedAt).duration?.short, "5m");
  });

  it("goes by the check time before mount, and gives no duration", () => {
    const checkedAt = Date.parse("2026-09-22T14:00:00Z");
    assert.deepEqual(incidentStart(checkedAt + 60_000, 0, checkedAt), { upcoming: true, duration: null });
    assert.deepEqual(incidentStart(checkedAt - 60_000, 0, checkedAt), { upcoming: false, duration: null });
    assert.deepEqual(incidentStart(checkedAt - 60_000, 0, Number.NaN), { upcoming: false, duration: null });
  });
});
