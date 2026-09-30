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
      return "No data";
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

/**
 * An incident's impact. "none" is a notice the vendor posted with no customer
 * impact: operational and informational, so the row is labelled a notice
 * instead of reading "Operational". A missing impact is not a reading at
 * all, so it is unknown rather than an all-clear.
 */
export function statuspageIncidentImpact(impact: string | undefined): { health: Health; informational: boolean } {
  const value = (impact ?? "").trim().toLowerCase();
  if (value === "none") return { health: "operational", informational: true };
  if (value === "") return { health: "unknown", informational: false };
  return { health: statuspageIndicator(value), informational: false };
}

/**
 * `degraded_performance` and `partial_outage` are both Degraded on the board
 * (the Health type has no fourth level), but they are not the same thing to
 * a reader. A partial outage keeps its name as the row's detail.
 */
export function statuspageComponentDetail(status: string | undefined): string | undefined {
  return (status ?? "").toLowerCase() === "partial_outage" ? "Partial outage" : undefined;
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

/**
 * What a Google status item's impact means for health, and whether it is a
 * mere notice. `status_impact` wins; `severity` (Play's dashboard) is only
 * read when the impact is missing or empty.
 *
 * SERVICE_INFORMATION (and AVAILABLE) is Google saying nothing is wrong for
 * customers: it reads as operational, flagged informational, so the item
 * stays listed as a notice and never makes the service look degraded. A
 * value this code does not know is "unknown", not a guess in either
 * direction: an open item of unclear severity is neither a confirmed
 * problem nor an all-clear. LOW and MEDIUM severities are real, if minor,
 * impact, so they stay degraded.
 */
export function googleImpactInfo(
  impact: string | undefined,
  severity?: string,
): { health: Health; informational: boolean } {
  const value = (impact?.trim() || severity?.trim() || "").toUpperCase();
  if (value.includes("SERVICE_OUTAGE") || value === "CRITICAL") return { health: "outage", informational: false };
  if (value.includes("SERVICE_DISRUPTION") || value === "HIGH" || value === "MEDIUM" || value === "LOW") {
    return { health: "degraded", informational: false };
  }
  if (value.includes("MAINTENANCE")) return { health: "maintenance", informational: false };
  if (value.includes("SERVICE_INFORMATION") || value.includes("AVAILABLE")) {
    return { health: "operational", informational: true };
  }
  return { health: "unknown", informational: false };
}

export function googleImpact(impact: string | undefined, severity?: string): Health {
  return googleImpactInfo(impact, severity).health;
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

export const ALL_CLEAR_SUMMARY = "Nothing reported.";

// `||`, not `??`: a vendor can send an empty description, and "" must fall
// back to the generic sentence rather than leave the card blank.
export function overallSummary(health: Health, incidentCount: number, componentHint?: string): string {
  if (health === "operational") {
    return incidentCount > 0 ? `Up. ${incidentCount} resolved recently.` : ALL_CLEAR_SUMMARY;
  }
  if (health === "maintenance") {
    return componentHint || "Maintenance in progress.";
  }
  if (health === "degraded") {
    return componentHint || "Some parts are slow or failing.";
  }
  if (health === "outage") {
    return componentHint || "Down right now.";
  }
  return "Couldn't read their status page.";
}
