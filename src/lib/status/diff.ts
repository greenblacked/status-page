import { describeVersionChanges, versionFingerprint } from "./changelog.ts";
import { worseHealth } from "./health.ts";
import type { BoardSnapshot, Health, ServiceId, ServiceSnapshot } from "./types.ts";

export type PulseChange = {
  id: ServiceId;
  name: string;
  from: Health;
  to: Health;
  summary: string;
  /**
   * Set (to true) when the service's newest versions changed: a new release,
   * which a release tracker shows with the neutral Changed bar. Left out for a
   * health-only change, so a recovery keeps the green one. When a check sees
   * both, it counts as a release.
   */
  release?: true;
};

export function overallHealth(board: BoardSnapshot): Health {
  return board.services.reduce((acc, service) => worseHealth(acc, service.health), "operational" as Health);
}

/**
 * A release tracker's newest versions when they differ from the previous
 * snapshot's, such as "RouterOS 7 stable 7.21"; "" when they did not change
 * or the service reports none. (A changed fingerprint with no nameable
 * version yields "" too: the caller treats that as no release.)
 */
export function releaseChange(before: ServiceSnapshot, after: ServiceSnapshot): string {
  const previousVersions = versionFingerprint(before.meta);
  const nextVersions = versionFingerprint(after.meta);
  if (!nextVersions || previousVersions === nextVersions) return "";
  return describeVersionChanges(previousVersions, nextVersions);
}

export function diffBoards(previous: BoardSnapshot, next: BoardSnapshot): PulseChange[] {
  const previousById = new Map(previous.services.map((service) => [service.id, service]));
  const changes: PulseChange[] = [];
  for (const service of next.services) {
    const before = previousById.get(service.id);
    if (!before) continue;
    const nextVersions = versionFingerprint(service.meta);
    const latestChanged = Boolean(nextVersions && versionFingerprint(before.meta) !== nextVersions);
    if (before.health === service.health && !latestChanged) continue;
    const releaseSummary = releaseChange(before, service);
    changes.push({
      id: service.id,
      name: service.name,
      from: before.health,
      to: service.health,
      summary: releaseSummary || service.summary,
      ...(latestChanged ? { release: true as const } : {}),
    });
  }
  return changes;
}
