export type ServiceId =
  | "gcp"
  | "aws"
  | "azure"
  | "steam"
  | "cs2-europe"
  | "epic"
  | "fortnite"
  | "spotify"
  | "apple"
  | "android"
  | "github"
  | "gitlab"
  | "confluence"
  | "grok"
  | "chatgpt"
  | "claude"
  | "mikrotik"
  | "apple-os"
  | "windows"
  | "android-os";

export type CategoryId = "cloud" | "gaming" | "platforms" | "ai" | "updates";

export type Health = "operational" | "degraded" | "outage" | "maintenance" | "unknown";

/**
 * What a release tracker knows about one version it lists, for the Details
 * pop-up on its card. Every field comes from the source the collector already
 * reads; a field the source does not give is left out, never filled in.
 */
export type ReleaseInfo = {
  /** "7.24.5", "27.2 beta 2", "26H2". */
  version: string;
  /** The build or revision, "24B5089g", "26300.1000", when the source gives one apart from the version. */
  build?: string;
  /** When it came out: an ISO 8601 timestamp, or a bare "2026-09-29" when the source gives only a day (UTC). */
  releasedAt?: string;
  /** When its latest update shipped, in the same two forms, when the source says and it differs. */
  updatedAt?: string;
  /** The vendor's own page for this release's notes (an https link). */
  url?: string;
  /** What the link says it is, when "Release page" is not true enough: "Release notes", "Apple Developer post". */
  linkLabel?: string;
  /** A few short plain-text lines taken from the vendor's notes, never more than MAX_NOTE_LINES. Absent when the source has none. */
  notes?: string[];
};

export type ComponentHealth = {
  name: string;
  health: Health;
  detail?: string;
  /** Set only by the release trackers (category "updates"): the version behind `detail`, for the Details pop-up. */
  release?: ReleaseInfo;
};

export type Incident = {
  id: string;
  title: string;
  health: Health;
  startedAt?: string;
  updatedAt?: string;
  url?: string;
  /**
   * True for an active vendor notice that reports no impact (a Statuspage
   * incident with impact "none", a Google SERVICE_INFORMATION item). It stays
   * in the list, labelled a notice rather than a health, and never counts as
   * a problem: `health` is then "operational" and only describes its impact.
   */
  informational?: boolean;
};

/** Maintenance the vendor has scheduled but not started. It never changes health. */
export type UpcomingMaintenance = {
  id: string;
  title: string;
  /** When it is due to start, as ISO 8601. */
  scheduledFor?: string;
  /** When it is due to end, as ISO 8601. */
  scheduledUntil?: string;
  url?: string;
};

export type ServiceSnapshot = {
  id: ServiceId;
  name: string;
  shortName: string;
  category: CategoryId;
  health: Health;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  checkedAt: string;
  latencyMs: number;
  components: ComponentHealth[];
  /**
   * Total components the source listed before the list was capped. Set only
   * when components were capped, so it is always greater than
   * `components.length`; absent means `components` is the whole list.
   */
  componentCount?: number;
  incidents: Incident[];
  /**
   * Total incidents the source listed before the list was capped. Set only
   * when incidents were capped, so it is always greater than
   * `incidents.length`; absent means `incidents` is the whole list.
   */
  incidentCount?: number;
  /** Scheduled, not yet started maintenance, soonest first. Absent when the vendor lists none. */
  upcomingMaintenance?: UpcomingMaintenance[];
  meta?: Record<string, string | number>;
  /** Set only when the collector itself failed; health is then "unknown". */
  failure?: SourceFailure;
};

/**
 * Why a collector could not produce a reading. "parser" means the vendor
 * answered but the payload was not the shape the collector expects, which is
 * the failure that needs a code change rather than patience.
 */
export type SourceFailure = {
  kind: "http" | "timeout" | "network" | "parser";
  message: string;
  status?: number;
};

export type BoardSnapshot = {
  generatedAt: string;
  durationMs: number;
  services: ServiceSnapshot[];
  counts: Record<Health, number>;
};
