import { diffBoards, overallHealth, type PulseChange } from "./diff.ts";
import { lastPulseAt, MAX_PULSES } from "./schedule.ts";
import type { BoardSnapshot, Health } from "./types.ts";

const STORAGE_KEY = "status-bar:pulses:v2";

export type Pulse = {
  slot: number;
  at: string;
  overall: Health;
  counts: BoardSnapshot["counts"];
  changes: PulseChange[];
  opening: boolean;
};

export type PulseStore = {
  lastSlot: number | null;
  lastBoard: BoardSnapshot | null;
  pulses: Pulse[];
};

export function emptyPulseStore(): PulseStore {
  return { lastSlot: null, lastBoard: null, pulses: [] };
}

export function makePulse(board: BoardSnapshot, slot: number, previous: BoardSnapshot | null): Pulse {
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
    byId.set(change.id, previous ? { ...change, from: previous.from } : change);
  }
  return [...byId.values()];
}

export function syncPulse(board: BoardSnapshot, now: number, existing: PulseStore): PulseStore {
  const slot = lastPulseAt(now);
  const changes = existing.lastBoard ? diffBoards(existing.lastBoard, board) : [];
  const sameSlot = existing.lastSlot === slot && existing.pulses.length > 0;

  if (sameSlot) {
    if (changes.length === 0) {
      if (existing.lastBoard === board) return existing;
      return { ...existing, lastBoard: board };
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
      lastBoard: board,
      pulses: [nextPulse, ...existing.pulses.slice(1)],
    };
  }

  return {
    lastSlot: slot,
    lastBoard: board,
    pulses: upsertPulse(existing.pulses, makePulse(board, slot, existing.lastBoard)),
  };
}

export function loadPulseStore(): PulseStore {
  try {
    if (typeof localStorage === "undefined") return emptyPulseStore();
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyPulseStore();
    const parsed = JSON.parse(raw) as PulseStore;
    if (!parsed || !Array.isArray(parsed.pulses)) return emptyPulseStore();
    return {
      lastSlot: typeof parsed.lastSlot === "number" ? parsed.lastSlot : null,
      lastBoard: parsed.lastBoard ?? null,
      pulses: parsed.pulses,
    };
  } catch {
    return emptyPulseStore();
  }
}

export function savePulseStore(store: PulseStore): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Private mode / quota — the in-memory store still works for this session.
  }
}
