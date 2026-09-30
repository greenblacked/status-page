import type { Health } from "./types.ts";

/**
 * The one severity order, worst first: outage, degraded, unknown,
 * maintenance, operational. Everything that ranks a state derives from it:
 * `worseHealth` (the board's overall health, the JSON API's `overall`, the
 * badge colour, a history day's worst state), `urgencyOf` (card order and
 * the order of a card's rows) and the board's headline.
 *
 * Unknown sits above maintenance and below a confirmed degradation. An
 * unreadable source may be hiding anything, so it is more worth a look than
 * planned work; but it is not a confirmed problem, so a real degradation is
 * never masked by it.
 */
export const SEVERITY_ORDER: readonly Health[] = ["outage", "degraded", "unknown", "maintenance", "operational"];

/** How urgent a state is: 0 (outage) is the worst, 4 (operational) the best. */
export function urgencyOf(health: Health): number {
  return SEVERITY_ORDER.indexOf(health);
}

export function worseHealth(a: Health, b: Health): Health {
  return urgencyOf(a) <= urgencyOf(b) ? a : b;
}

export function healthLabel(health: Health): string {
  switch (health) {
    case "operational":
      return "Operational";
    case "degraded":
      return "Degraded";
    case "outage":
      return "Outage";
    case "maintenance":
      return "Maintenance";
    default:
      return "Unknown";
  }
}

export function statuspageIndicator(indicator: string | undefined): Health {
  switch ((indicator ?? "none").toLowerCase()) {
    case "none":
      return "operational";
    case "minor":
      return "degraded";
    case "major":
      return "outage";
    case "critical":
      return "outage";
    case "maintenance":
      return "maintenance";
    default:
      return "unknown";
  }
}

export function statuspageComponent(status: string | undefined): Health {
  switch ((status ?? "").toLowerCase()) {
    case "operational":
      return "operational";
    case "degraded_performance":
    case "partial_outage":
      return "degraded";
    case "major_outage":
      return "outage";
    case "under_maintenance":
      return "maintenance";
    default:
      return "unknown";
  }
}

export function googleImpact(impact: string | undefined, severity?: string): Health {
  const value = (impact ?? severity ?? "").toUpperCase();
  if (value.includes("SERVICE_OUTAGE") || value === "CRITICAL" || value === "HIGH") {
    return value.includes("SERVICE_OUTAGE") || value === "CRITICAL" ? "outage" : "degraded";
  }
  if (value.includes("SERVICE_DISRUPTION") || value === "MEDIUM") return "degraded";
  if (value.includes("MAINTENANCE")) return "maintenance";
  if (value.includes("AVAILABLE") || value === "LOW") return "degraded";
  return "degraded";
}

// Instatus component statuses (status.x.ai/v2/components.json), which are
// upper-case words without separators.
export function instatusComponent(status: string | undefined): Health {
  switch ((status ?? "").toUpperCase()) {
    case "OPERATIONAL":
      return "operational";
    case "DEGRADEDPERFORMANCE":
    case "PARTIALOUTAGE":
      return "degraded";
    case "MAJOROUTAGE":
      return "outage";
    case "UNDERMAINTENANCE":
      return "maintenance";
    default:
      return "unknown";
  }
}

export const ALL_CLEAR_SUMMARY = "All reported systems operational.";

// `||`, not `??`: a vendor can send an empty description, and "" must fall
// back to the generic sentence rather than leave the card blank.
export function overallSummary(health: Health, incidentCount: number, componentHint?: string): string {
  if (health === "operational") {
    return incidentCount > 0
      ? `Clear. ${incidentCount} recently resolved item${incidentCount === 1 ? "" : "s"}.`
      : ALL_CLEAR_SUMMARY;
  }
  if (health === "maintenance") {
    return componentHint || "Scheduled maintenance is in progress.";
  }
  if (health === "degraded") {
    return componentHint || "Degraded performance on one or more components.";
  }
  if (health === "outage") {
    return componentHint || "An outage is affecting this service.";
  }
  return "Status could not be confirmed from the official source.";
}

// What the board's Attention count is made of, worst first.
const ATTENTION_ORDER = SEVERITY_ORDER.filter((health) => health !== "operational");

export function attentionBreakdown(counts: Record<Health, number>): string {
  const parts = ATTENTION_ORDER.filter((health) => counts[health] > 0).map(
    (health) => `${counts[health]} ${healthLabel(health).toLowerCase()}`,
  );
  return parts.length ? parts.join(" · ") : "nothing to watch";
}
