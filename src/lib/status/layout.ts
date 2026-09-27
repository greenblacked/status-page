import type { BoardSnapshot, Health, ServiceSnapshot } from "./types.ts";

// Worst first. Unknown ranks above degraded: a source that cannot be read
// may be hiding anything, and it is also the one the board cannot vouch for.
const SEVERITY: Record<Health, number> = {
  outage: 0,
  unknown: 1,
  degraded: 2,
  maintenance: 3,
  operational: 4,
};

export type BoardGroups = {
  /** Anything not operational, worst first, then in catalog order. */
  attention: ServiceSnapshot[];
  /** Operational status services. */
  operational: ServiceSnapshot[];
  /** Operational release trackers (the Updates category). */
  releases: ServiceSnapshot[];
};

export function groupServices(services: ServiceSnapshot[]): BoardGroups {
  const attention = services
    .filter((service) => service.health !== "operational")
    // Array.prototype.sort is stable, so equal severities keep catalog order.
    .sort((a, b) => SEVERITY[a.health] - SEVERITY[b.health]);
  const healthy = services.filter((service) => service.health === "operational");
  return {
    attention,
    operational: healthy.filter((service) => service.category !== "updates"),
    releases: healthy.filter((service) => service.category === "updates"),
  };
}

export function serviceAnchor(id: ServiceSnapshot["id"]): string {
  return `service-${id}`;
}

function names(services: ServiceSnapshot[]): string {
  const list = services.map((service) => service.name);
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/**
 * The one sentence at the top of the board. It names the worst confirmed
 * problem, so a glance answers "is something I use broken?" without reading
 * the cards. Confirmed breakage (outage, then degraded) is named before an
 * unreadable source, so `tone` is the health of what the title names, which
 * can differ from the board's overall health (where unknown outranks
 * degraded).
 */
export function boardHeadline(board: BoardSnapshot): { tone: Health; title: string } {
  const by = (health: Health) => board.services.filter((service) => service.health === health);
  const outage = by("outage");
  const degraded = by("degraded");
  const unknown = by("unknown");
  const maintenance = by("maintenance");

  if (outage.length) {
    return {
      tone: "outage",
      title: outage.length <= 2 ? `Outage: ${names(outage)}` : `${outage.length} services are down`,
    };
  }
  if (degraded.length) {
    return {
      tone: "degraded",
      title: degraded.length <= 2 ? `Degraded: ${names(degraded)}` : `${degraded.length} services degraded`,
    };
  }
  if (unknown.length) {
    return {
      tone: "unknown",
      title:
        unknown.length === 1 ? `${unknown[0].name} could not be read` : `${unknown.length} sources could not be read`,
    };
  }
  if (maintenance.length) {
    return {
      tone: "maintenance",
      title:
        maintenance.length <= 2
          ? `Maintenance: ${names(maintenance)}`
          : `${maintenance.length} services in maintenance`,
    };
  }
  return { tone: "operational", title: "All systems operational" };
}

/** Browser tab title: the number of services needing attention, if any. */
export function documentTitle(board: BoardSnapshot, appName: string): string {
  const attention = board.services.filter((service) => service.health !== "operational").length;
  return attention ? `(${attention}) ${appName}` : appName;
}
