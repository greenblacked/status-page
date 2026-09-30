export type ServiceId =
  | "gcp"
  | "aws"
  | "steam"
  | "cs2-europe"
  | "epic"
  | "fortnite"
  | "spotify"
  | "apple"
  | "android"
  | "grok"
  | "chatgpt"
  | "claude"
  | "mikrotik"
  | "apple-os";

export type CategoryId = "cloud" | "gaming" | "platforms" | "ai" | "updates";

export type Health = "operational" | "degraded" | "outage" | "maintenance" | "unknown";

export type ComponentHealth = {
  name: string;
  health: Health;
  detail?: string;
};

export type Incident = {
  id: string;
  title: string;
  health: Health;
  startedAt?: string;
  updatedAt?: string;
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
