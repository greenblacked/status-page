import { describeVersionChanges, versionFingerprint } from "./changelog.ts";
import { worseHealth } from "./health.ts";
import type { BoardSnapshot, Health, ServiceId } from "./types.ts";

export type PulseChange = {
  id: ServiceId;
  name: string;
  from: Health;
  to: Health;
  summary: string;
};

export function overallHealth(board: BoardSnapshot): Health {
  return board.services.reduce((acc, service) => worseHealth(acc, service.health), "operational" as Health);
}

export function diffBoards(previous: BoardSnapshot, next: BoardSnapshot): PulseChange[] {
  const previousById = new Map(previous.services.map((service) => [service.id, service]));
  const changes: PulseChange[] = [];
  for (const service of next.services) {
    const before = previousById.get(service.id);
    if (!before) continue;
    const previousVersions = versionFingerprint(before.meta);
    const nextVersions = versionFingerprint(service.meta);
    const latestChanged = Boolean(nextVersions && previousVersions !== nextVersions);
    if (before.health === service.health && !latestChanged) continue;
    const releaseSummary = latestChanged ? describeVersionChanges(previousVersions, nextVersions) : "";
    changes.push({
      id: service.id,
      name: service.name,
      from: before.health,
      to: service.health,
      summary: releaseSummary || service.summary,
    });
  }
  return changes;
}
