import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  CACHE_TTL_MS,
  everyInterval,
  formatAge,
  formatCountdown,
  formatDuration,
  formatSlotTime,
  formatStaleAge,
  formatUtcTime,
  freshnessOf,
  incidentStart,
  isStale,
  lastPulseAt,
  liveState,
  nextPulseAt,
  nextRefetchAt,
  noteSnapshot,
  PULSE_INTERVAL_MS,
  parseTimestamp,
  periodPhase,
  pickRefetchJitter,
  pulseProgress,
  REFETCH_JITTER_MAX_MS,
  REFETCH_JITTER_MIN_MS,
  STALE_AFTER_MS,
  spokenDuration,
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
    assert.equal(formatAge(23_000), "23\u202fs ago");
    assert.equal(formatAge(3 * 60 * 1000), "3\u202fmin ago");
    assert.equal(formatAge(59 * 60 * 1000), "59\u202fmin ago");
    assert.equal(formatAge(2 * 3600 * 1000), "2\u202fh ago");
  });
});

describe("refetch schedule", () => {
  const noon = Date.parse("2026-09-22T12:00:00.000Z");

  it("picks a jitter inside the window", () => {
    assert.equal(
      pickRefetchJitter(() => 0),
      REFETCH_JITTER_MIN_MS,
    );
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

describe("period phase", () => {
  const noon = Date.parse("2026-09-22T12:00:00.000Z");
  const jitter = 20_000;

  it("starts at the refetch and ends at the next one", () => {
    const start = periodPhase(noon + jitter, jitter);
    assert.equal(start.endsAt, noon + jitter + PULSE_INTERVAL_MS);
    assert.equal(start.elapsedMs, 0);
    assert.equal(start.progress, 0);
    const quarter = periodPhase(noon + jitter + 30_000, jitter);
    assert.equal(quarter.elapsedMs, 30_000);
    assert.equal(quarter.progress, 0.25);
  });

  it("agrees with the countdown at every second", () => {
    for (let now = noon; now < noon + 2 * PULSE_INTERVAL_MS; now += 999) {
      const phase = periodPhase(now, jitter);
      assert.equal(phase.endsAt, nextRefetchAt(now, jitter));
      assert.equal(phase.elapsedMs + (phase.endsAt - now), PULSE_INTERVAL_MS);
      assert.ok(phase.progress >= 0 && phase.progress < 1);
    }
  });

  it("rounds down to a step for a dial that moves in steps", () => {
    const phase = periodPhase(noon + jitter + 32_400, jitter, 5_000);
    assert.equal(phase.elapsedMs, 30_000);
    assert.equal(phase.progress, 0.25);
    assert.equal(phase.endsAt, noon + jitter + PULSE_INTERVAL_MS);
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

  it("calls a snapshot stale on arrival when it is hours old by the server's clock", () => {
    // Opened long after the board stopped: stale at once, with its real age.
    const seen = noteSnapshot(null, generatedAt, at + 3 * 60 * 60_000);
    assert.equal(seen?.seenAt, at);
    assert.equal(isStale(seen?.seenAt ?? 0, at + 3 * 60 * 60_000), true);
    // Within what clock skew could explain, the browser's clock still decides.
    const skewed = noteSnapshot(null, generatedAt, at + 20 * 60_000);
    assert.equal(isStale(skewed?.seenAt ?? 0, at + 20 * 60_000), false);
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
    assert.equal(formatStaleAge(7 * 60_000 + 30_000), "7\u202fmin ago");
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

  it("labels a board log slot in UTC, whatever the visitor's time zone", () => {
    assert.equal(formatSlotTime(Date.parse("2026-09-27T17:44:00Z")), "17:44\u202fUTC");
    assert.equal(formatSlotTime(Date.parse("2026-09-28T00:04:00Z")), "00:04\u202fUTC");
  });

  it("formats a start as UTC clock time, adding the date only when it differs", () => {
    const at = Date.parse("2026-09-22T09:05:00Z");
    assert.equal(formatUtcTime(at), "09:05\u202fUTC");
    assert.equal(formatUtcTime(at, Date.parse("2026-09-22T23:59:00Z")), "09:05\u202fUTC");
    assert.equal(formatUtcTime(at, Date.parse("2026-09-24T01:00:00Z")), "22 Sep 09:05\u202fUTC");
    assert.equal(formatUtcTime(at, Date.parse("2027-01-02T01:00:00Z")), "22 Sep 2026 09:05\u202fUTC");
  });

  it("formats how long an incident has lasted", () => {
    const minute = 60_000;
    assert.deepEqual(formatDuration(20_000), { short: "under\u202f1m", long: "under a minute", iso: "PT0H0M" });
    assert.equal(formatDuration(-5 * minute), null);
    assert.equal(formatDuration(-1), null);
    assert.equal(formatDuration(Number.NaN), null);
    assert.deepEqual(formatDuration(45 * minute), { short: "45m", long: "45 minutes", iso: "PT0H45M" });
    assert.deepEqual(formatDuration(130 * minute), {
      short: "2h\u202f10m",
      long: "2 hours 10 minutes",
      iso: "PT2H10M",
    });
    assert.deepEqual(formatDuration(60 * minute), { short: "1h", long: "1 hour", iso: "PT1H0M" });
    assert.deepEqual(formatDuration((76 * 60 + 1) * minute), {
      short: "3d\u202f4h",
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

describe("live signal", () => {
  it("shows a running check first, then a stale board, then live", () => {
    assert.equal(liveState(true, true), "checking");
    assert.equal(liveState(true, false), "checking");
    assert.equal(liveState(false, true), "stale");
    assert.equal(liveState(false, false), "live");
  });
});

describe("freshnessOf", () => {
  const seenAt = Date.parse("2026-09-27T12:00:00Z");
  const seen = { generatedAt: "2026-09-27T12:00:00Z", seenAt };

  it("is live and ageless before mount", () => {
    assert.deepEqual(freshnessOf(null, false, 0), { ageMs: 0, stale: false, state: "live" });
  });

  it("goes stale after six minutes, unless a check is running", () => {
    assert.deepEqual(freshnessOf(seen, false, seenAt + 60_000), { ageMs: 60_000, stale: false, state: "live" });
    const late = seenAt + STALE_AFTER_MS + 1;
    assert.deepEqual(freshnessOf(seen, false, late), { ageMs: STALE_AFTER_MS + 1, stale: true, state: "stale" });
    assert.deepEqual(freshnessOf(seen, true, late), { ageMs: STALE_AFTER_MS + 1, stale: false, state: "checking" });
  });
});

describe("footer cadence copy", () => {
  it("spells out whole minutes and counts seconds", () => {
    assert.equal(spokenDuration(60_000), "one minute");
    assert.equal(spokenDuration(120_000), "two minutes");
    assert.equal(spokenDuration(600_000), "ten minutes");
    assert.equal(spokenDuration(11 * 60_000), "11 minutes");
    assert.equal(spokenDuration(45_000), "45 seconds");
    assert.equal(spokenDuration(1_000), "1 second");
    assert.equal(spokenDuration(90_000), "90 seconds");
  });

  it("phrases a cadence", () => {
    assert.equal(everyInterval(60_000), "every minute");
    assert.equal(everyInterval(120_000), "every two minutes");
    assert.equal(everyInterval(30_000), "every 30 seconds");
  });

  it("reads today's constants as the copy the footer used to hard-code", () => {
    assert.equal(everyInterval(PULSE_INTERVAL_MS), "every two minutes");
    assert.equal(spokenDuration(CACHE_TTL_MS), "45 seconds");
  });
});
