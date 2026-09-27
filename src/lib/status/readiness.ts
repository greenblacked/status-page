import type { BoardSnapshot } from "./types.ts";

/**
 * How old the board may get before /readyz calls it stale. The board is
 * collected every two minutes (the Workers cron, or the Node cache on
 * demand), so ten minutes is several missed sweeps in a row, not one slow
 * vendor or one skipped tick.
 */
export const READY_MAX_AGE_MS = 10 * 60 * 1000;

export type ReadinessStatus = "ready" | "stale" | "blind";

export type Readiness = {
  /** `stale`: older than READY_MAX_AGE_MS. `blind`: no service could be read. */
  status: ReadinessStatus;
  generatedAt: string;
  ageSeconds: number;
  services: number;
  unknown: number;
};

/**
 * Whether the board is fit to serve: recent, and built from at least one
 * source that answered. Pure, so the thresholds are tested without a
 * server; the /readyz route only turns the result into a response.
 *
 * A snapshot with no parseable `generatedAt` counts as stale rather than
 * fresh: its age cannot be shown to be small.
 */
export function readiness(board: BoardSnapshot, now: number): Readiness {
  const generated = Date.parse(board.generatedAt);
  const ageMs = Number.isFinite(generated) ? Math.max(0, now - generated) : Number.POSITIVE_INFINITY;
  const services = board.services.length;
  const unknown = board.services.filter((service) => service.health === "unknown").length;
  let status: ReadinessStatus = "ready";
  if (ageMs > READY_MAX_AGE_MS) status = "stale";
  else if (services === 0 || unknown === services) status = "blind";
  return {
    status,
    generatedAt: board.generatedAt,
    // JSON has no Infinity; -1 says "unknown age" without breaking a parser.
    ageSeconds: Number.isFinite(ageMs) ? Math.floor(ageMs / 1000) : -1,
    services,
    unknown,
  };
}
