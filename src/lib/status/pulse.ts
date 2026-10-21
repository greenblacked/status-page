import { diffBoards, overallHealth, type PulseChange } from "./diff.ts";
import { isHealth } from "./history.ts";
import { lastPulseAt, MAX_PULSES } from "./schedule.ts";
import type { BoardSnapshot, Health, ServiceSnapshot } from "./types.ts";

/** The local-storage key of the saved checks; the script that holds Recent changes' height reads it too (feed-reserve.ts). */
export const PULSE_STORAGE_KEY = "status-bar:pulses:v2";

export type Pulse = {
  slot: number;
  at: string;
  overall: Health;
  counts: BoardSnapshot["counts"];
  changes: PulseChange[];
  opening: boolean;
};

/** A service as the saved last board keeps it: what the next check's diff reads, and its name and summary. */
export type SavedService = Pick<ServiceSnapshot, "id" | "name" | "health" | "summary"> & {
  /** Only the versions a release is told by (see versionFingerprint), and only when the service has them. */
  meta?: Partial<Record<"versions" | "latest", string | number>>;
};

/**
 * The board the last check saw, as it is saved. Every check used to rewrite the whole board here (each service's
 * components, incidents and release feed) for a diff that reads a few fields of each service.
 */
export type SavedBoard = Pick<BoardSnapshot, "generatedAt" | "counts"> & { services: SavedService[] };

export type PulseStore = {
  lastSlot: number | null;
  lastBoard: SavedBoard | null;
  pulses: Pulse[];
};

export function emptyPulseStore(): PulseStore {
  return { lastSlot: null, lastBoard: null, pulses: [] };
}

const META_KEYS = ["versions", "latest"] as const;

function slimService(service: SavedService): SavedService {
  const { id, name, health, summary } = service;
  const meta: NonNullable<SavedService["meta"]> = {};
  for (const key of META_KEYS) {
    const value = service.meta?.[key];
    if (value !== undefined) meta[key] = value;
  }
  return Object.keys(meta).length > 0 ? { id, name, health, summary, meta } : { id, name, health, summary };
}

/** The board as the pulse store saves it (SavedBoard): only what the readers of `lastBoard` use. */
export function slimBoard(board: SavedBoard): SavedBoard {
  return { generatedAt: board.generatedAt, counts: board.counts, services: board.services.map(slimService) };
}

/**
 * Whether two saved boards say the same, so a check that brought nothing new need not be saved again. The counts
 * follow from the services' health, so the services say it all.
 */
function sameSavedBoard(a: SavedBoard, b: SavedBoard): boolean {
  if (a.generatedAt !== b.generatedAt || a.services.length !== b.services.length) return false;
  return a.services.every((service, index) => {
    const other = b.services[index];
    return (
      other !== undefined &&
      service.id === other.id &&
      service.name === other.name &&
      service.health === other.health &&
      service.summary === other.summary &&
      META_KEYS.every((key) => service.meta?.[key] === other.meta?.[key])
    );
  });
}

export function makePulse(board: BoardSnapshot, slot: number, previous: SavedBoard | null): Pulse {
  return {
    slot,
    at: board.generatedAt,
    overall: overallHealth(board),
    counts: board.counts,
    changes: previous ? diffBoards(previous, board) : [],
    opening: !previous,
  };
}

export function upsertPulse(pulses: Pulse[], pulse: Pulse): Pulse[] {
  const without = pulses.filter((item) => item.slot !== pulse.slot);
  return [pulse, ...without].sort((a, b) => b.slot - a.slot).slice(0, MAX_PULSES);
}

export function mergeChanges(existing: PulseChange[], incoming: PulseChange[]): PulseChange[] {
  const byId = new Map(existing.map((change) => [change.id, change]));
  for (const change of incoming) {
    const previous = byId.get(change.id);
    // A release seen earlier in the slot stays a release when a later check only moves the health.
    const release = previous?.release || change.release;
    byId.set(change.id, previous ? { ...change, from: previous.from, ...(release ? { release } : {}) } : change);
  }
  return [...byId.values()];
}

export function syncPulse(board: BoardSnapshot, now: number, existing: PulseStore): PulseStore {
  const slot = lastPulseAt(now);
  const changes = existing.lastBoard ? diffBoards(existing.lastBoard, board) : [];
  const sameSlot = existing.lastSlot === slot && existing.pulses.length > 0;
  const lastBoard = slimBoard(board);

  if (sameSlot) {
    if (changes.length === 0) {
      // The same store, not an equal copy: the board saves only a store that is new (see BoardView).
      if (existing.lastBoard && sameSavedBoard(existing.lastBoard, lastBoard)) return existing;
      return { ...existing, lastBoard };
    }
    const current = existing.pulses[0];
    const nextPulse: Pulse = {
      ...current,
      at: board.generatedAt,
      overall: overallHealth(board),
      counts: board.counts,
      changes: mergeChanges(current.opening ? [] : current.changes, changes),
      opening: false,
    };
    return {
      lastSlot: slot,
      lastBoard,
      pulses: [nextPulse, ...existing.pulses.slice(1)],
    };
  }

  return {
    lastSlot: slot,
    lastBoard,
    pulses: upsertPulse(existing.pulses, makePulse(board, slot, existing.lastBoard)),
  };
}

const COUNT_KEYS = ["operational", "degraded", "outage", "maintenance", "unknown"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPulseChange(value: unknown): value is PulseChange {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isHealth(value.from) &&
    isHealth(value.to) &&
    typeof value.summary === "string" &&
    (value.release === undefined || value.release === true)
  );
}

function isCounts(value: unknown): value is Pulse["counts"] {
  return (
    isRecord(value) &&
    COUNT_KEYS.every((key) => typeof value[key] === "number" && Number.isFinite(value[key] as number))
  );
}

/** A stored pulse with the shape the feed reads, its unreadable changes dropped; null when it is not one. */
function parsePulse(value: unknown): Pulse | null {
  if (!isRecord(value)) return null;
  if (typeof value.slot !== "number" || !Number.isFinite(value.slot)) return null;
  if (typeof value.at !== "string" || !isHealth(value.overall)) return null;
  if (!isCounts(value.counts) || typeof value.opening !== "boolean" || !Array.isArray(value.changes)) return null;
  return {
    slot: value.slot,
    at: value.at,
    overall: value.overall,
    counts: value.counts,
    changes: value.changes.filter(isPulseChange),
    opening: value.opening,
  };
}

/**
 * The board the last check saw, as far as diffBoards reads it: a list of
 * services, each with an id and a health. Services without those are dropped
 * and a value with no list is null, so a tampered entry costs a diff, not
 * the page. The services are otherwise kept as stored, so a whole board that
 * an earlier version saved reads too; a later sync saves it slim.
 */
function parseLastBoard(value: unknown): SavedBoard | null {
  if (!isRecord(value) || !Array.isArray(value.services)) return null;
  const services = value.services.filter(
    (service): service is SavedService =>
      isRecord(service) && typeof service.id === "string" && isHealth(service.health),
  );
  return { ...(value as SavedBoard), services };
}

/**
 * What localStorage held, made safe to use: a stored value that is not an
 * object with a list of pulses is a fresh store; otherwise only well-formed
 * pulses are kept (newest first, at most MAX_PULSES) and a last board that
 * does not read is forgotten. Storage is the user's to edit and is shared
 * across versions, so nothing in it is trusted. The key and the format are
 * unchanged.
 */
export function parsePulseStore(value: unknown): PulseStore {
  if (!isRecord(value) || !Array.isArray(value.pulses)) return emptyPulseStore();
  const pulses = value.pulses
    .map(parsePulse)
    .filter((pulse): pulse is Pulse => pulse !== null)
    .sort((a, b) => b.slot - a.slot)
    .slice(0, MAX_PULSES);
  // The last slot says "the newest pulse is this one"; when that pulse was
  // dropped (or is not the newest), the claim is false and the next sync must
  // open a new pulse instead of merging into the wrong one.
  const lastSlot = typeof value.lastSlot === "number" && value.lastSlot === pulses[0]?.slot ? value.lastSlot : null;
  return {
    lastSlot,
    lastBoard: parseLastBoard(value.lastBoard),
    pulses,
  };
}

export function loadPulseStore(): PulseStore {
  try {
    if (typeof localStorage === "undefined") return emptyPulseStore();
    const raw = localStorage.getItem(PULSE_STORAGE_KEY);
    if (!raw) return emptyPulseStore();
    return parsePulseStore(JSON.parse(raw));
  } catch {
    return emptyPulseStore();
  }
}

export function savePulseStore(store: PulseStore): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PULSE_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Private mode / quota — the in-memory store still works for this session.
  }
}
