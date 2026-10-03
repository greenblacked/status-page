import { describeVersionChanges, parseVersionMap, versionFingerprint } from "./changelog.ts";
import { worseHealth } from "./health.ts";
import type { BoardSnapshot, Health, ServiceId, ServiceSnapshot } from "./types.ts";

export type PulseChange = {
  id: ServiceId;
  name: string;
  from: Health;
  to: Health;
  summary: string;
  /**
   * Set (to true) when the service's newest versions moved from known
   * versions: a new release, which a release tracker shows with the neutral
   * Changed bar. Left out for a health-only change, so a recovery keeps the
   * green one. A source coming back from unread has no earlier versions to
   * compare with, so it counts as a recovery, including a recovery that also
   * brought a new version (that cannot be detected).
   */
  release?: true;
};

export function overallHealth(board: BoardSnapshot): Health {
  return board.services.reduce((acc, service) => worseHealth(acc, service.health), "operational" as Health);
}

/**
 * A release tracker's newest versions when they differ from the previous
 * snapshot's, such as "RouterOS 7 stable 7.21"; "" when they did not change
 * or the service reports none. A snapshot that had no versions (a failed
 * check carries no meta) is not a baseline: the first reading after it is a
 * recovery, not a release. (A changed fingerprint with no nameable version
 * yields "" too: the caller treats that as no release.)
 */
export function releaseChange(before: ServiceSnapshot, after: ServiceSnapshot): string {
  const previousVersions = versionFingerprint(before.meta);
  const nextVersions = versionFingerprint(after.meta);
  if (!previousVersions || !nextVersions || previousVersions === nextVersions) return "";
  const previousMap = parseVersionMap(previousVersions);
  const nextMap = parseVersionMap(nextVersions);
  // A format change is no release for the names the board already had; a name it did not have still is one.
  if (isFingerprintMigration(previousMap, nextMap)) {
    return Object.keys(nextMap)
      .filter((name) => !(name in previousMap))
      .map((name) => `${name} ${nextMap[name]}`)
      .join(" · ");
  }
  return describeVersionChanges(previousVersions, nextVersions);
}

/**
 * A fingerprint that gives every name the fixed word "released" where a name it shares with the previous one
 * carried something else is a format change (Windows once carried each version's build), not a release: a board
 * stored before the change must not read as one. The names may be fewer than before (Microsoft dropped an
 * end-of-life row before the first refresh) or include a new one; only a new one is a release. A fingerprint
 * that was already all "released" (Android) has nothing to migrate and is compared as usual.
 */
function isFingerprintMigration(before: Record<string, string>, after: Record<string, string>): boolean {
  const names = Object.keys(after);
  return (
    names.length > 0 &&
    names.every((name) => after[name] === "released") &&
    names.some((name) => name in before && before[name] !== "released")
  );
}

export function diffBoards(previous: BoardSnapshot, next: BoardSnapshot): PulseChange[] {
  const previousById = new Map(previous.services.map((service) => [service.id, service]));
  const changes: PulseChange[] = [];
  for (const service of next.services) {
    const before = previousById.get(service.id);
    if (!before) continue;
    // A version that only left the list (an old post dropping out of a feed) is not a release.
    const releaseSummary = releaseChange(before, service);
    const latestChanged = releaseSummary !== "";
    if (before.health === service.health && !latestChanged) continue;
    changes.push({
      id: service.id,
      name: service.name,
      from: before.health,
      to: service.health,
      summary: releaseSummary || service.summary,
      // releaseChange is "" without known previous versions, so latestChanged means a release from known versions.
      ...(latestChanged ? { release: true as const } : {}),
    });
  }
  return changes;
}
