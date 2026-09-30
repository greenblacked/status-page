/// <reference types="@cloudflare/workers-types" />
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1Fake } from "@/test/d1-fake";
import { board, service } from "@/test/fixtures";
import { HISTORY_RETENTION_DAYS, oldestRetainedDate, parseHistory, worseHistoryHealth } from "./history";
import {
  ensureSchema,
  HISTORY_ORDER,
  HISTORY_SLOT_MS,
  type HistoryDb,
  readPublicHistory,
  recordBoardSample,
  rowsToHistory,
} from "./history-store";
import type { Health, ServiceId, ServiceSnapshot } from "./types";

// 2026-09-25T12:00:00Z, on a slot boundary.
const NOON = Date.UTC(2026, 8, 25, 12, 0, 0);
const MIDNIGHT = Date.UTC(2026, 8, 25, 0, 0, 0);
const SLOT = HISTORY_SLOT_MS;

// A real D1Database is usable wherever a HistoryDb is asked for.
const asHistoryDb = (db: D1Database): HistoryDb => db;
void asHistoryDb;

let db: D1Fake;

beforeEach(async () => {
  db = new D1Fake();
  await ensureSchema(db);
});

afterEach(() => db.close());

function sample(health: Health, id: ServiceId = "aws", extra: Partial<ServiceSnapshot> = {}) {
  return board([service(id, { health, ...extra })]);
}

function insertRow(day: string, id: string, values: { samples?: number; up?: number; worst?: number; slot?: number }) {
  db.sqlite
    .prepare(
      "INSERT INTO history_day_v1 (day, service_id, samples, up_samples, worst, last_slot) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(day, id, values.samples ?? 1, values.up ?? 1, values.worst ?? 0, values.slot ?? 1);
}

describe("ensureSchema", () => {
  it("creates the table and is idempotent", async () => {
    await ensureSchema(db);
    await ensureSchema(db);
    expect(db.prepared.filter((sql) => sql.startsWith("CREATE TABLE"))).toHaveLength(1);
    expect(db.rows()).toEqual([]);
  });

  it("is also harmless against a database that already has the table", async () => {
    const other = new D1Fake();
    other.sqlite.exec(
      "CREATE TABLE history_day_v1 (day TEXT NOT NULL, service_id TEXT NOT NULL, samples INTEGER NOT NULL, up_samples INTEGER NOT NULL, worst INTEGER NOT NULL, last_slot INTEGER NOT NULL, PRIMARY KEY (day, service_id)) WITHOUT ROWID",
    );
    await expect(ensureSchema(other)).resolves.toBeUndefined();
    other.close();
  });

  it("does not remember a failure, so the next run retries", async () => {
    const real = new D1Fake();
    let failNext = true;
    const flaky: HistoryDb = {
      prepare: (query) => {
        const statement = real.prepare(query);
        if (!failNext) return statement;
        failNext = false;
        return { ...statement, run: () => Promise.reject(new Error("d1 down")) } as typeof statement;
      },
      batch: (statements) => real.batch(statements),
      exec: (query) => real.exec(query),
    };
    await expect(ensureSchema(flaky)).rejects.toThrow("d1 down");
    await expect(ensureSchema(flaky)).resolves.toBeUndefined();
    expect(real.rows()).toEqual([]);
    real.close();
  });
});

describe("recordBoardSample", () => {
  it("creates the day row on the first sample", async () => {
    const result = await recordBoardSample(db, sample("operational"), NOON);
    expect(result).toEqual({ slot: NOON / SLOT, services: 1, skipped: 0 });
    expect(db.rows()).toEqual([
      { day: "2026-09-25", service_id: "aws", samples: 1, up_samples: 1, worst: 0, last_slot: NOON / SLOT },
    ]);
  });

  it("counts a repeated scheduledTime, or another instant in the same slot, once", async () => {
    await recordBoardSample(db, sample("operational"), NOON);
    await recordBoardSample(db, sample("outage"), NOON);
    await recordBoardSample(db, sample("outage"), NOON + SLOT - 1);
    expect(db.rows()).toEqual([
      { day: "2026-09-25", service_id: "aws", samples: 1, up_samples: 1, worst: 0, last_slot: NOON / SLOT },
    ]);
  });

  it("ignores a slot older than the last one counted", async () => {
    await recordBoardSample(db, sample("operational"), NOON);
    await recordBoardSample(db, sample("outage"), NOON - SLOT);
    expect(db.rows()[0]).toMatchObject({ samples: 1, up_samples: 1, worst: 0, last_slot: NOON / SLOT });
  });

  it("keeps the operational fraction across samples", async () => {
    await recordBoardSample(db, sample("operational"), NOON);
    await recordBoardSample(db, sample("degraded"), NOON + SLOT);
    await recordBoardSample(db, sample("operational"), NOON + 2 * SLOT);
    expect(db.rows()[0]).toMatchObject({ samples: 3, up_samples: 2, last_slot: NOON / SLOT + 2 });
    const history = await readPublicHistory(db, NOON + 2 * SLOT);
    expect(history.services.aws.days).toEqual([{ date: "2026-09-25", worst: "degraded", samples: 3, up: 2 / 3 }]);
  });

  it("never lowers a day's worst health", async () => {
    await recordBoardSample(db, sample("outage"), NOON);
    await recordBoardSample(db, sample("operational"), NOON + SLOT);
    await recordBoardSample(db, sample("degraded"), NOON + 2 * SLOT);
    expect(db.rows()[0]).toMatchObject({ samples: 3, up_samples: 1, worst: HISTORY_ORDER.indexOf("outage") });
  });

  it("stores each health at its history rank and reads it back", async () => {
    const ids: ServiceId[] = ["aws", "gcp", "steam", "epic", "spotify"];
    const services = HISTORY_ORDER.map((health, index) => service(ids[index], { health }));
    await recordBoardSample(db, board(services), NOON);
    const history = await readPublicHistory(db, NOON);
    HISTORY_ORDER.forEach((health, index) => {
      expect(history.services[ids[index]].days[0]).toMatchObject({
        worst: health,
        up: health === "operational" ? 1 : 0,
      });
    });
  });

  it("splits samples at UTC midnight", async () => {
    const last = MIDNIGHT - SLOT;
    await recordBoardSample(db, sample("degraded"), last);
    await recordBoardSample(db, sample("operational"), MIDNIGHT);
    expect(db.rows()).toEqual([
      { day: "2026-09-24", service_id: "aws", samples: 1, up_samples: 0, worst: 3, last_slot: last / SLOT },
      { day: "2026-09-25", service_id: "aws", samples: 1, up_samples: 1, worst: 0, last_slot: MIDNIGHT / SLOT },
    ]);
  });

  it("skips a service whose collector failed, and updates cards", async () => {
    const result = await recordBoardSample(
      db,
      board([
        service("aws"),
        service("gcp", { health: "unknown", failure: { kind: "timeout", message: "slow" } }),
        service("mikrotik", { category: "updates" }),
      ]),
      NOON,
    );
    expect(result).toEqual({ slot: NOON / SLOT, services: 1, skipped: 2 });
    expect(db.rows().map((row) => row.service_id)).toEqual(["aws"]);
  });

  it("records nothing when every service failed", async () => {
    const failure = { kind: "network", message: "down" } as const;
    const result = await recordBoardSample(db, board([service("aws", { failure }), service("gcp", { failure })]), NOON);
    expect(result).toEqual({ slot: NOON / SLOT, services: 0, skipped: 2 });
    expect(db.rows()).toEqual([]);
    expect(db.batches.committed).toBe(0);
  });

  it("rejects a non-finite scheduledTime", async () => {
    await expect(recordBoardSample(db, sample("operational"), Number.NaN)).rejects.toThrow("scheduledTime");
    expect(db.rows()).toEqual([]);
  });

  it("prunes on the first slot of a UTC day, dropping day 31 and keeping day 30", async () => {
    const today = "2026-09-25";
    const oldest = oldestRetainedDate(today, HISTORY_RETENTION_DAYS);
    const dayBefore = new Date(Date.parse(`${oldest}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    insertRow(dayBefore, "aws", {});
    insertRow(oldest, "aws", {});
    await recordBoardSample(db, sample("operational"), MIDNIGHT);
    expect(db.rows().map((row) => row.day)).toEqual([oldest, today]);
  });

  it("does not prune at other slots", async () => {
    insertRow("2026-01-01", "aws", {});
    await recordBoardSample(db, sample("operational"), NOON);
    expect(db.rows().map((row) => row.day)).toEqual(["2026-01-01", "2026-09-25"]);
  });

  it("prunes even when every service failed that slot", async () => {
    insertRow("2026-01-01", "aws", {});
    await recordBoardSample(
      db,
      board([service("aws", { failure: { kind: "http", message: "500", status: 500 } })]),
      MIDNIGHT,
    );
    expect(db.rows()).toEqual([]);
  });

  it("commits a batch whole or not at all", async () => {
    const good = db.prepare("INSERT INTO history_day_v1 VALUES ('2026-09-25', 'aws', 1, 1, 0, 1)");
    const bad = db.prepare("INSERT INTO nowhere VALUES (1)");
    await expect(db.batch([good, bad])).rejects.toThrow();
    expect(db.rows()).toEqual([]);
    expect(db.batches.rolledBack).toBe(1);
  });
});

describe("HISTORY_ORDER", () => {
  it("ranks health exactly as history.ts does", () => {
    for (const a of HISTORY_ORDER) {
      for (const b of HISTORY_ORDER) {
        const expected = HISTORY_ORDER[Math.max(HISTORY_ORDER.indexOf(a), HISTORY_ORDER.indexOf(b))];
        expect(worseHistoryHealth(a, b)).toBe(expected);
      }
    }
  });
});

describe("rowsToHistory", () => {
  it("builds the internal document from rows and dates updatedAt by the newest slot", () => {
    const rows = [
      { day: "2026-09-24", service_id: "aws", samples: 288, up_samples: 287, worst: 3, last_slot: 100 },
      { day: "2026-09-25", service_id: "aws", samples: 2, up_samples: 2, worst: 0, last_slot: 200 },
    ];
    const history = rowsToHistory([rows[1], rows[0]], NOON);
    expect(history.updatedAt).toBe(new Date(200 * SLOT).toISOString());
    expect(history.services.aws.days.map((day) => day.date)).toEqual(["2026-09-24", "2026-09-25"]);
    expect(history.services.aws.days[0]).toEqual({
      date: "2026-09-24",
      worst: "degraded",
      samples: 288,
      up: 287 / 288,
    });
  });

  it("dates an empty document by now", () => {
    expect(rowsToHistory([], NOON)).toMatchObject({ updatedAt: new Date(NOON).toISOString(), services: {} });
  });

  it("drops malformed rows and days outside the window", () => {
    const good = { day: "2026-09-25", service_id: "aws", samples: 1, up_samples: 1, worst: 0, last_slot: 1 };
    const history = rowsToHistory(
      [
        null,
        "row",
        { ...good, samples: 0 },
        { ...good, worst: 9 },
        { ...good, worst: 1.5 },
        { ...good, day: "yesterday" },
        { ...good, service_id: "" },
        { ...good, up_samples: -1 },
        { ...good, last_slot: Number.NaN },
        { ...good, day: "2026-08-26" },
        { ...good, service_id: "gcp", up_samples: 5 },
      ],
      NOON,
    );
    expect(Object.keys(history.services)).toEqual(["gcp"]);
    expect(history.services.gcp.days[0].up).toBe(1);
  });
});

describe("readPublicHistory", () => {
  it("returns an empty public document when there is no database", async () => {
    const history = await readPublicHistory(undefined, NOON);
    expect(history).toEqual({
      schema: 1,
      updatedAt: new Date(NOON).toISOString(),
      timezone: "UTC",
      retentionDays: 30,
      services: {},
    });
  });

  it("returns an empty document when the table does not exist yet", async () => {
    const fresh = new D1Fake();
    const history = await readPublicHistory(fresh, NOON);
    expect(history.services).toEqual({});
    expect(parseHistory(history)).not.toBeNull();
    fresh.close();
  });

  it("returns a document that passes parseHistory unchanged", async () => {
    await recordBoardSample(db, board([service("aws"), service("gcp", { health: "degraded" })]), NOON);
    await recordBoardSample(db, board([service("aws"), service("gcp")]), NOON + SLOT);
    const history = await readPublicHistory(db, NOON + SLOT);
    expect(parseHistory(history)).toEqual(history);
    expect(history.updatedAt).toBe(new Date(NOON + SLOT).toISOString());
    expect(Object.keys(history.services)).toEqual(["aws", "gcp"]);
    expect(history.services.gcp.days).toEqual([{ date: "2026-09-25", worst: "degraded", samples: 2, up: 0.5 }]);
  });

  it("filters out days before the retention window", async () => {
    insertRow("2026-08-26", "aws", {});
    insertRow("2026-08-27", "aws", {});
    const history = await readPublicHistory(db, NOON);
    expect(history.services.aws.days.map((day) => day.date)).toEqual(["2026-08-27"]);
  });

  it("throws any other database error", async () => {
    const broken: HistoryDb = {
      prepare: () => {
        throw new Error("D1_ERROR: database is locked");
      },
      batch: () => Promise.resolve([]),
      exec: () => Promise.resolve(undefined),
    };
    await expect(readPublicHistory(broken, NOON)).rejects.toThrow("database is locked");
  });

  it("recognises a missing table wrapped in a cause", async () => {
    const wrapped: HistoryDb = {
      prepare: () => {
        throw new Error("D1_ERROR", { cause: new Error("no such table: history_day_v1: SQLITE_ERROR") });
      },
      batch: () => Promise.resolve([]),
      exec: () => Promise.resolve(undefined),
    };
    expect((await readPublicHistory(wrapped, NOON)).services).toEqual({});
  });
});
