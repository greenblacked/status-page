import type { BoardSnapshot, Health, ServiceSnapshot } from "./types";

function emptyCounts(): Record<Health, number> {
  return { operational: 0, degraded: 0, outage: 0, maintenance: 0, unknown: 0 };
}

export function assembleBoard(services: ServiceSnapshot[], durationMs: number): BoardSnapshot {
  const counts = emptyCounts();
  for (const service of services) counts[service.health] += 1;
  return {
    generatedAt: new Date().toISOString(),
    durationMs,
    services,
    counts,
  };
}

/**
 * Sweeps every vendor once and assembles the result into a board snapshot.
 * Shared by the Node in-memory cache (board.ts) and the Cloudflare cron
 * trigger (cron-sweep.ts), so there is exactly one place that calls
 * `collectAllServices()`.
 */
export async function collectBoard(): Promise<BoardSnapshot> {
  const started = Date.now();
  const { collectAllServices } = await import("./sources.server");
  const services = await collectAllServices();
  return assembleBoard(services, Date.now() - started);
}
