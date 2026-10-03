import { androidReleases, readAndroidVersionLinks } from "./android-release.ts";
import { boundSnapshot, clip, MAX_TEXT_CHARS } from "./bounds.ts";
import { CATALOG_BY_ID } from "./catalog.ts";
import {
  formatReleaseAge,
  formatVersionMap,
  isFreshRelease,
  latestAppleOsByFamily,
  MIKROTIK_CHANNELS,
  mikrotikChangelogUrl,
  parseMikrotikNewest,
  splitAppleBuild,
} from "./changelog.ts";
import { fingerprint } from "./fingerprint.ts";
import {
  googleImpactInfo,
  instatusComponent,
  overallSummary,
  statusIoHealth,
  statuspageComponent,
  statuspageComponentDetail,
  statuspageIncidentImpact,
  statuspageIndicator,
  urgencyOf,
  worseHealth,
} from "./health.ts";
import {
  fetchJson,
  fetchText,
  isRefusal,
  meterBytes,
  meteredBytes,
  NotJsonError,
  PayloadError,
  SourceError,
} from "./http.ts";
import { sortIncidents } from "./layout.ts";
import type {
  ComponentHealth,
  Health,
  Incident,
  ServiceId,
  ServiceSnapshot,
  SourceFailure,
  UpcomingMaintenance,
} from "./types.ts";
import { hostOf, vendorUrl } from "./vendor-url.ts";
import { readHtmlTables, WINDOWS_NAME, windowsReleases, windowsShippedAt } from "./windows-release.ts";

const STALE_MS = 14 * 24 * 60 * 60 * 1000;
// How far ahead of this server's clock a vendor's timestamp may be and still be read as now: their clock can
// lead ours by a few minutes. A date further ahead is not a moment that has happened, so it is no evidence of a
// current incident (a 2030 stamp would otherwise keep an item active until 14 days after it).
const FUTURE_SKEW_MS = 5 * 60 * 1000;
// Whether a vendor timestamp (ms) is within the last STALE_MS, allowing FUTURE_SKEW_MS of clock skew.
function isRecent(at: number, now: number): boolean {
  return Number.isFinite(at) && now - at >= -FUTURE_SKEW_MS && now - at <= STALE_MS;
}
// Upper bound on components kept per card. The largest real vendor list is
// Google Cloud (~215 products); the snapshot is cached and served as JSON, so a
// runaway page must still not grow it without limit.
const MAX_COMPONENTS = 300;
// Upper bound on incidents kept per card. Each is a row in the board, the
// JSON API and the Atom feed; a feed that lists thousands must not grow them.
// Applied by sortIncidents after the board's ordering, so the cut drops the
// mildest, oldest rows and never the outage.
const MAX_INCIDENTS = 50;
/**
 * Most entries read from any one array of a Statuspage or Status.io payload
 * (components, incidents, maintenance), in document order; the rest are not
 * looked at. The other JSON readers are bounded by the body cap alone. The
 * 4 MiB body cap alone allows a million `{}` entries, and mapping them
 * allocated hundreds of MiB before the caps above applied. This is the bound
 * for the work and memory a payload can cost, in the way MAX_RSS_SCANNED is
 * for a feed: it sits an order of magnitude over the largest real list.
 */
export const MAX_SCANNED_ROWS = 5000;
/** Most entries read from an array nested in one of those rows (a component's containers, an incident's messages). */
export const MAX_NESTED_ROWS = 500;
// Extra, optional fetches (component lists, the Steam connection managers)
// get their own short deadline so a slow side request never holds up the
// main feed. Each is fail-soft: a failure loses that list, not the card.
const EXTRA_TIMEOUT_MS = 4000;
const EU_POPS = new Set(["ams", "fra", "fsn", "hel", "lhr", "mad", "par", "sto", "sto2", "vie", "waw"]);

// Every field a vendor could omit is optional: a missing one must cost a
// detail, never the whole card (a TypeError here is a "parser" failure).
type StatuspageRef = { id?: string; name?: string; group_id?: string | null };

type StatuspageSummary = {
  status?: { indicator?: string; description?: string };
  components?: Array<{
    id?: string;
    name?: string;
    status?: string;
    group?: boolean;
    group_id?: string | null;
  }>;
  incidents?: Array<{
    id?: string;
    name?: string;
    status?: string;
    impact?: string;
    shortlink?: string;
    started_at?: string;
    updated_at?: string;
    /** The components (and groups) the incident affects. */
    components?: StatuspageRef[];
  }>;
  scheduled_maintenances?: Array<{
    id?: string;
    name?: string;
    status?: string;
    started_at?: string;
    updated_at?: string;
    scheduled_for?: string;
    scheduled_until?: string;
    shortlink?: string;
    components?: StatuspageRef[];
  }>;
};

// Status.io's public status API (the host behind status.gitlab.com). Every
// field a vendor could omit is optional, like the Statuspage type above.
type StatusIoContainer = { id?: string; name?: string; status?: string; status_code?: number };
type StatusIoComponent = StatusIoContainer & { containers?: StatusIoContainer[] };
type StatusIoMessage = { details?: string; state?: number; status?: number; datetime?: string };
type StatusIoEvent = {
  _id?: string;
  name?: string;
  datetime_open?: string;
  datetime_planned_start?: string;
  datetime_planned_end?: string;
  messages?: StatusIoMessage[];
};
type StatusIoStatus = {
  result?: {
    status_overall?: { updated?: string; status?: string; status_code?: number };
    status?: StatusIoComponent[];
    incidents?: StatusIoEvent[];
    maintenance?: { active?: StatusIoEvent[]; upcoming?: StatusIoEvent[] };
  };
};

type GoogleIncident = {
  id: string;
  begin?: string;
  end?: string | null;
  modified?: string;
  external_desc?: string;
  status_impact?: string;
  severity?: string;
  service_name?: string;
  uri?: string;
  currently_affected_locations?: Array<{ title?: string }>;
  affected_products?: Array<{ id?: string; title?: string }>;
};

type GoogleProduct = { id?: string; title: string };

type AwsEvent = {
  date?: string;
  arn?: string;
  region_name?: string;
  status?: string;
  service?: string;
  service_name?: string;
  impacted_services?: Record<string, { service_name?: string; current?: string | number; max?: string | number }>;
  summary?: string;
  end_time?: string | number | null;
  event_log?: Array<{ summary?: string; message?: string; status?: number; timestamp?: number }>;
};

type AppleStatus = {
  services?: Array<{
    serviceName: string;
    events?: Array<{
      eventStatus?: string;
      statusType?: string;
      message?: string;
      usersAffected?: string;
      epochStartDate?: number;
      epochEndDate?: number;
      datePosted?: string;
    }>;
  }>;
};

type SteamSdr = {
  success?: boolean;
  pops?: Record<
    string,
    {
      desc?: string;
      geo?: number[];
      tier?: number;
      relays?: Array<{ ipv4?: string }>;
    }
  >;
};

function base(
  id: ServiceId,
  checkedAt: string,
  latencyMs: number,
): Omit<ServiceSnapshot, "health" | "summary" | "components" | "incidents"> {
  const entry = CATALOG_BY_ID[id];
  return {
    id: entry.id,
    name: entry.name,
    shortName: entry.shortName,
    category: entry.category,
    sourceName: entry.sourceName,
    sourceUrl: entry.sourceUrl,
    checkedAt,
    latencyMs,
  };
}

const JSON_SYNTAX_MESSAGE = "SyntaxError: response was not valid JSON";

// SourceError is raised by http.ts for transport problems. Anything else that
// escapes a collector (SyntaxError from JSON.parse, TypeError from a missing
// field) means the vendor answered with a shape the collector does not expect.
export function classifyFailure(error: unknown): SourceFailure {
  if (error instanceof PayloadError) return { kind: "parser", message: error.message };
  if (error instanceof SourceError) {
    if (error.status !== undefined) return { kind: "http", message: error.message, status: error.status };
    if (error.message.startsWith("Timed out")) return { kind: "timeout", message: error.message };
    return { kind: "network", message: error.message };
  }
  // V8's JSON.parse message quotes the first characters of the body, which
  // would carry vendor (or attacker) text into hydration data, logs and the
  // public source-health issue. A fixed sentence says the same thing.
  if (error instanceof SyntaxError) return { kind: "parser", message: JSON_SYNTAX_MESSAGE };
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { kind: "parser", message };
}

function failed(id: ServiceId, started: number, error: unknown): ServiceSnapshot {
  // A SourceError's message is written to be read, except a non-JSON hint: that
  // is for logs and the failure record, so the card gets the generic sentence.
  const message =
    error instanceof SourceError && !(error instanceof NotJsonError)
      ? error.message
      : "Official source did not respond.";
  const failure = classifyFailure(error);
  const latencyMs = Date.now() - started;
  // One JSON line per failed collector, so a host's log shows which vendor
  // broke and how without anyone watching the board. No payloads, no URLs
  // beyond the vendor host already in the message. `bytes` is what it read
  // before failing (collectAllServices meters each collector).
  console.warn(
    JSON.stringify({
      event: "collector_failed",
      service: id,
      kind: failure.kind,
      status: failure.status,
      // Logged before boundSnapshot sees the snapshot, so held to its limit here.
      message: clip(failure.message, MAX_TEXT_CHARS),
      latencyMs,
      bytes: meteredBytes(),
    }),
  );
  return {
    ...base(id, new Date().toISOString(), latencyMs),
    health: "unknown",
    summary: message,
    components: [],
    incidents: [],
    failure,
  };
}

function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  return fn().then((value) => ({ value, ms: Date.now() - started }));
}

/** Incidents that are problems: notices with no impact are listed but not counted. */
function realIncidentCount(incidents: Incident[]): number {
  return incidents.filter((incident) => !incident.informational).length;
}

/** The `limit` items due soonest; one with no usable date is last. Dates are parsed once, not per comparison. */
function soonest(items: UpcomingMaintenance[], limit: number): UpcomingMaintenance[] {
  return items
    .map((item) => ({ item, at: Date.parse(item.scheduledFor ?? "") || Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.at - b.at)
    .slice(0, limit)
    .map(({ item }) => item);
}

/**
 * The incidents to list, in board order and cut to MAX_INCIDENTS, with what
 * the cut hides: `incidentCount` (the count read) is set only when some were
 * cut, like `componentCount`, and `problems` counts the real
 * ones in the whole list, which is what a summary should say. The count is at
 * most MAX_SCANNED_ROWS only where the reader cuts its arrays first (the
 * Statuspage and Status.io readers); the others are bounded by the 4 MiB body
 * cap, and the RSS readers also by MAX_RSS_SCANNED and the 200 newest items.
 */
function listIncidents(
  all: Incident[],
  limit = MAX_INCIDENTS,
): {
  incidents: Incident[];
  problems: number;
  incidentCount?: number;
} {
  return {
    incidents: sortIncidents(all, limit),
    problems: realIncidentCount(all),
    ...(all.length > limit ? { incidentCount: all.length } : {}),
  };
}

/** The title of the worst incident that is a problem (the list is sorted worst first), if any. */
function firstProblemTitle(incidents: Incident[]): string | undefined {
  return incidents.find((incident) => !incident.informational)?.title;
}

function googleIncidents(incidents: GoogleIncident[], id: "gcp" | "android") {
  const { sourceUrl } = CATALOG_BY_ID[id];
  const open = incidents.filter((incident) => !incident.end);
  let health: Health = "operational";
  const components: ComponentHealth[] = [];
  const mapped: Incident[] = open.map((incident) => {
    const { health: itemHealth, informational } = googleImpactInfo(incident.status_impact, incident.severity);
    health = worseHealth(health, itemHealth);
    const locations = (incident.currently_affected_locations ?? [])
      .map((loc) => loc.title)
      .filter(Boolean)
      .join(", ");
    // A notice names no affected service: it is not a row.
    if (!informational) {
      components.push({
        name: incident.service_name ?? "Service",
        health: itemHealth,
        detail: locations || incident.external_desc,
      });
    }
    return {
      id: incident.id,
      title: incident.external_desc ?? incident.service_name ?? "Incident",
      health: itemHealth,
      ...(informational ? { informational: true } : {}),
      startedAt: isoTimestamp(incident.begin),
      updatedAt: isoTimestamp(incident.modified),
      // Resolved rather than concatenated: the feed's "incidents/<id>" form
      // has no leading slash, and concatenation produced
      // "https://status.cloud.google.comincidents/<id>". vendorUrl keeps it
      // on Google's own status host, whatever the feed says.
      url: vendorUrl(incident.uri, sourceUrl, [hostOf(sourceUrl)]),
    };
  });
  return { health, ...listIncidents(mapped), components };
}

/**
 * The product catalogue of a Google status dashboard (`products.json`) as
 * `{ id?, title }` rows in the vendor's order. Accepts the bare array or an
 * object holding it as `products`. Anything else, a row without a title and a
 * repeated title yield nothing, so a malformed catalogue is an empty one and
 * the caller falls back to what the incidents name.
 */
export function parseGoogleProducts(payload: unknown): GoogleProduct[] {
  const list = Array.isArray(payload) ? payload : (payload as { products?: unknown } | null)?.products;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const products: GoogleProduct[] = [];
  for (const row of list) {
    const title = typeof row?.title === "string" ? row.title.trim() : "";
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    products.push({ id: typeof row.id === "string" && row.id ? row.id : undefined, title });
  }
  return products;
}

/**
 * One component per catalogue product, in the catalogue's order. A product is
 * as unhealthy as the worst open incident that lists it in
 * `affected_products` (or, for an incident that lists none, names it as its
 * `service_name`), with exactly the impact mapping the card uses
 * (`googleImpact`), so a row never reads healthier than the card's own
 * badge for the same incident. An affected product the catalogue does not
 * list is added after it, because the vendor named it. Pass open incidents
 * only.
 */
export function googleComponents(products: GoogleProduct[], openIncidents: GoogleIncident[]): ComponentHealth[] {
  type Row = ComponentHealth & { id?: string };
  const rows: Row[] = [];
  // Rows by id and by lower-cased name, so matching a reference is a lookup
  // rather than a scan of every product. The first row with a key wins, as
  // the scan it replaces did; `rows` keeps the catalogue's order.
  const byId = new Map<string, number>();
  const byName = new Map<string, number>();
  const add = (row: Row): Row => {
    const index = rows.push(row) - 1;
    if (row.id !== undefined && !byId.has(row.id)) byId.set(row.id, index);
    const key = row.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, index);
    return row;
  };
  for (const product of products) add({ id: product.id, name: product.title, health: "operational" });
  const find = (ref: { id?: string; title?: string }): Row | undefined => {
    const title = ref.title?.trim().toLowerCase();
    const viaId = ref.id !== undefined ? byId.get(ref.id) : undefined;
    const viaName = title !== undefined ? byName.get(title) : undefined;
    const index = viaId === undefined ? viaName : viaName === undefined ? viaId : Math.min(viaId, viaName);
    return index === undefined ? undefined : rows[index];
  };
  for (const incident of openIncidents) {
    const refs = incident.affected_products?.length
      ? incident.affected_products
      : incident.service_name
        ? [{ title: incident.service_name }]
        : [];
    const { health: itemHealth, informational } = googleImpactInfo(incident.status_impact, incident.severity);
    // A notice reports no impact, so it changes no product's row.
    if (informational) continue;
    const locations = (incident.currently_affected_locations ?? [])
      .map((loc) => loc.title)
      .filter(Boolean)
      .join(", ");
    for (const ref of refs) {
      const name = ref.title?.trim();
      if (!ref.id && !name) continue;
      let row = find(ref);
      if (!row) {
        if (!name) continue;
        row = add({ id: ref.id, name, health: "operational" });
      }
      // The worst incident wins the row; among equals, the first listed.
      const worse = worseHealth(row.health, itemHealth);
      if (worse !== row.health) {
        row.health = worse;
        row.detail = locations || incident.external_desc;
      }
    }
  }
  return rows.map(({ name, health, detail }) => (detail ? { name, health, detail } : { name, health }));
}

// Non-operational first, in the board's urgency order (SEVERITY_ORDER: outage,
// degraded, unknown, maintenance; equals keep source order), then operational
// in source order, capped at MAX_COMPONENTS so the cap can never drop the worst rows. `componentCount` is
// the count read (at most MAX_SCANNED_ROWS where the reader cuts its arrays first, as the
// Statuspage and Status.io readers do), set only when the cap dropped some, so a card
// can say how many it is not showing.
function rankComponents(components: ComponentHealth[]): Pick<ServiceSnapshot, "components" | "componentCount"> {
  const isUp = (component: ComponentHealth) => component.health === "operational";
  const broken = components.filter((c) => !isUp(c)).sort((a, b) => urgencyOf(a.health) - urgencyOf(b.health));
  const ranked = [...broken, ...components.filter(isUp)].slice(0, MAX_COMPONENTS);
  return components.length > MAX_COMPONENTS
    ? { components: ranked, componentCount: components.length }
    : { components: ranked };
}

/**
 * The objects in the first `limit` entries of a vendor array; anything else (a
 * null entry, a non-array) is skipped, not a crash. The cut comes before the
 * filter, so a payload of millions of entries costs `limit` of work and memory.
 */
export function records<T extends object>(value: unknown, limit = MAX_SCANNED_ROWS): T[] {
  return Array.isArray(value)
    ? value.slice(0, limit).filter((item): item is T => typeof item === "object" && item !== null)
    : [];
}

const MAX_UPCOMING_MAINTENANCE = 3;

function fromStatuspage(
  id: ServiceId,
  data: StatuspageSummary,
  latencyMs: number,
  componentFilter?: (name: string, groupName?: string) => boolean,
): ServiceSnapshot {
  // A summary always carries `status`. A body without it is not a summary
  // (a rate-limit or maintenance notice that happens to be JSON), and reading
  // it as "none" would be an all-clear built on no data.
  if (typeof data?.status !== "object" || data.status === null) {
    throw new PayloadError("Statuspage summary has no status.");
  }
  const checkedAt = new Date().toISOString();
  const { sourceUrl } = CATALOG_BY_ID[id];
  const statuspageHosts = ["stspg.io", hostOf(sourceUrl)];
  const allComponents = records<NonNullable<StatuspageSummary["components"]>[number]>(data.components);
  // Components stay in the vendor's array order, which is the page order.
  // (`position` is per group, so sorting on it would interleave groups.)
  // The name filter (Epic/Fortnite) sees groups too, and each child's group
  // name, so a group row can carry the health of a matching service and
  // plain-named children follow their group; groups are just never listed.
  const groupNames = new Map<string, string>();
  const componentsById = new Map<string, (typeof allComponents)[number]>();
  for (const component of allComponents) {
    if (component.id) componentsById.set(component.id, component);
    if (component.group && component.id) groupNames.set(component.id, component.name ?? "");
  }
  const matched = allComponents
    .filter((component) =>
      componentFilter
        ? componentFilter(component.name ?? "", component.group_id ? groupNames.get(component.group_id) : undefined)
        : !component.group,
    )
    .map((component) => ({
      name: component.name ?? "Component",
      group: component.group === true,
      health: statuspageComponent(component.status),
      detail: statuspageComponentDetail(component.status),
    }));
  // Leaf components only: groups are containers, not services.
  const components: ComponentHealth[] = matched
    .filter((component) => !component.group)
    .map(({ name, health, detail }) => (detail ? { name, health, detail } : { name, health }));

  // The list is capped only when returned (see rankComponents). Health is
  // worked out from every component first, so a broken one past the cap
  // still counts.
  let health = componentFilter
    ? matched.reduce((acc, component) => worseHealth(acc, component.health), "operational" as Health)
    : statuspageIndicator(data.status?.indicator);

  if (componentFilter && matched.length === 0) {
    health = statuspageIndicator(data.status?.indicator);
  }

  // Which of the shared page's cards an incident or maintenance belongs to.
  // The components it lists are the vendor's own word for what it affects, so
  // they decide when present (an incident called "Login issues" that lists a
  // Fortnite component is Fortnite's); the name is only a fallback for an
  // item that lists none.
  const belongs = (item: { name?: string; components?: StatuspageRef[] }): boolean => {
    if (!componentFilter) return true;
    const refs = records<StatuspageRef>(item.components, MAX_NESTED_ROWS);
    if (refs.length === 0) return componentFilter(item.name ?? "");
    return refs.some((ref) => {
      const known = ref.id ? componentsById.get(ref.id) : undefined;
      const groupId = ref.group_id ?? known?.group_id;
      return componentFilter(ref.name ?? known?.name ?? "", groupId ? groupNames.get(groupId) : undefined);
    });
  };

  const activeIncidents = records<NonNullable<StatuspageSummary["incidents"]>[number]>(data.incidents).filter(
    (incident) => {
      const status = (incident.status ?? "").toLowerCase();
      return status !== "resolved" && status !== "postmortem" && status !== "completed";
    },
  );

  const mapped: Incident[] = activeIncidents
    .filter((incident) => belongs(incident))
    .map((incident) => {
      const name = incident.name || "Incident";
      const { health: itemHealth, informational } = statuspageIncidentImpact(incident.impact);
      return {
        id: incident.id || `statuspage-${fingerprint(`${incident.name ?? ""}|${incident.started_at ?? ""}`)}`,
        title: name,
        health: itemHealth,
        ...(informational ? { informational: true } : {}),
        startedAt: isoTimestamp(incident.started_at),
        updatedAt: isoTimestamp(incident.updated_at),
        // Statuspage writes incident shortlinks on stspg.io; the vendor's own
        // status host is allowed too. No shortlink stays no link, as before.
        url: incident.shortlink ? vendorUrl(incident.shortlink, sourceUrl, statuspageHosts) : undefined,
      };
    });

  // An active incident is a statement about the service in its own right:
  // vendors often leave every component Operational while an incident is
  // open (Claude's "Delayed credits"), so the components and the page
  // indicator are only a floor. A card is never better than its worst active
  // problem, taken over the whole list (not just the part kept below). A
  // notice with no impact (informational) never raises it. An incident whose
  // impact the vendor left out still is a problem: it counts as Degraded, not
  // as "No data" (the incident's own row keeps its unknown state).
  for (const incident of mapped) {
    if (!incident.informational)
      health = worseHealth(health, incident.health === "unknown" ? "degraded" : incident.health);
  }

  const { incidents, problems, incidentCount } = listIncidents(mapped);

  const scheduled = records<NonNullable<StatuspageSummary["scheduled_maintenances"]>[number]>(
    data.scheduled_maintenances,
  ).filter((item) => belongs(item));
  const statusOf = (item: { status?: string }) => (item.status ?? "").toLowerCase();
  const maintenances = scheduled.filter((item) => statusOf(item) === "in_progress" || statusOf(item) === "verifying");

  if (maintenances.length && health === "operational") health = "maintenance";

  // Announced but not started: shown as upcoming, never as a health.
  const upcoming: UpcomingMaintenance[] = soonest(
    scheduled
      .filter((item) => statusOf(item) === "scheduled")
      .map((item) => ({
        id: item.id || `statuspage-${fingerprint(`${item.name ?? ""}|${item.scheduled_for ?? ""}`)}`,
        title: item.name || "Scheduled maintenance",
        scheduledFor: isoTimestamp(item.scheduled_for),
        scheduledUntil: isoTimestamp(item.scheduled_until),
        url: item.shortlink ? vendorUrl(item.shortlink, sourceUrl, statuspageHosts) : undefined,
      })),
    MAX_UPCOMING_MAINTENANCE,
  );

  // During maintenance with no incident, the maintenance itself is what the
  // card should name; the indicator description is only a generic fallback.
  const hint =
    firstProblemTitle(incidents) ||
    (health === "maintenance" ? maintenances[0]?.name : undefined) ||
    data.status?.description;
  return {
    ...base(id, checkedAt, latencyMs),
    health,
    summary: overallSummary(health, problems, hint),
    ...rankComponents(components),
    incidents,
    ...(incidentCount ? { incidentCount } : {}),
    ...(upcoming.length ? { upcomingMaintenance: upcoming } : {}),
  };
}

// GCP and Play share one dashboard format: `incidents.json` is the health
// signal and `products.json` is the catalogue the component list is cut from.
// The catalogue is a side request: it runs beside the incidents and, if it is
// slow, missing or unreadable, the card keeps the per-incident components.
async function collectGoogle(id: "gcp" | "android", origin: string): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const [{ value, ms }, catalogue] = await Promise.all([
      timed(() => fetchJson<GoogleIncident[]>(`${origin}/incidents.json`)),
      fetchJson<unknown>(`${origin}/products.json`, { timeoutMs: EXTRA_TIMEOUT_MS }).catch(() => null),
    ]);
    const parsed = googleIncidents(value, id);
    const products = parseGoogleProducts(catalogue);
    const components = products.length
      ? googleComponents(
          products,
          value.filter((incident) => !incident.end),
        )
      : parsed.components;
    return {
      ...base(id, new Date().toISOString(), ms),
      health: parsed.health,
      summary: overallSummary(parsed.health, parsed.problems, firstProblemTitle(parsed.incidents)),
      ...rankComponents(components),
      incidents: parsed.incidents,
      ...(parsed.incidentCount ? { incidentCount: parsed.incidentCount } : {}),
    };
  } catch (error) {
    return failed(id, started, error);
  }
}

const collectGcp = () => collectGoogle("gcp", "https://status.cloud.google.com");
const collectAndroid = () => collectGoogle("android", "https://status.play.google.com");

// `includes("resolved")` also matched "unresolved" and "not yet resolved",
// which would read a live incident's own update as its resolution.
export function saysResolved(text: string): boolean {
  const t = text.toLowerCase();
  return /\bresolved\b/.test(t) && !/\bnot\s+(?:yet\s+)?(?:been\s+)?resolved\b/.test(t);
}

type AwsLogEntry = NonNullable<AwsEvent["event_log"]>[number];

/**
 * The newest `event_log` entry by timestamp. The log's order is not trusted
 * (`.at(-1)` read whichever entry the vendor listed last, which is not
 * always the latest), so this takes the maximum timestamp; an entry without
 * a readable one loses to any that has one, and among equals the later entry
 * in the list wins.
 */
export function awsLatestLog(event: AwsEvent): AwsLogEntry | undefined {
  let latest: AwsLogEntry | undefined;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const entry of event.event_log ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const at = Number(entry.timestamp ?? Number.NaN);
    const value = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
    if (latest === undefined || value >= latestAt) {
      latest = entry;
      latestAt = value;
    }
  }
  return latest;
}

// A reported status or level as a number, or NaN when it is not a reading.
// null and "" coerce to 0, which would read as resolved, so only a real
// number or a non-blank numeric string counts.
function awsLevel(raw: unknown): number {
  return typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "") ? Number(raw) : Number.NaN;
}

export function awsEventActive(event: AwsEvent, now: number): boolean {
  if (event.end_time) return false;
  const summary = event.summary ?? "";
  if (/^\[resolved\]/i.test(summary)) return false;
  const last = awsLatestLog(event);
  const lastTs = (Number(last?.timestamp ?? event.date ?? 0) || 0) * 1000;
  if (!lastTs || !isRecent(lastTs, now)) return false;
  const lastMessage = `${last?.summary ?? ""} ${last?.message ?? ""}`.toLowerCase();
  // `Number(undefined)` is NaN and `NaN !== 0` is true, so an event missing
  // `status` used to count as active. Fall back to the update text instead.
  const status = awsLevel(event.status);
  if (!Number.isFinite(status)) return !saysResolved(lastMessage);
  if (saysResolved(lastMessage) && status === 0) return false;
  return status !== 0;
}

/**
 * An event's health as a whole. AWS reports `status` as 0 (resolved), 1
 * (informational), 2 (performance issue) or 3 (service disruption), and the
 * vendor's own reading comes first: a disruption is an outage even in one
 * region, and a performance issue is Degraded. Only an informational or
 * unreported status falls back to the words of the event: maintenance, a
 * regional Health item (one AZ or region, impact rather than a global
 * outage) or an outage word.
 */
function awsHealthFromEvent(event: AwsEvent): Health {
  const last = awsLatestLog(event);
  const level = awsLevel(event.status);
  if (level === 3) return "outage";
  const text = `${event.summary ?? ""} ${last?.message ?? ""}`.toLowerCase();
  if (text.includes("maintenance")) return "maintenance";
  if (level === 2) return "degraded";
  const region = (event.region_name ?? "").trim();
  if (region || /region availability/.test(text) || /availability zone/.test(text)) return "degraded";
  if (text.includes("outage") || text.includes("unavailable")) return "outage";
  return "degraded";
}

/**
 * An epoch timestamp from a vendor payload as an ISO string, or undefined
 * when it is missing, not a number ("n/a", ""), or outside the range a Date
 * can hold. `new Date(NaN).toISOString()` throws a RangeError, and one bad
 * timestamp on one event used to fail the whole collector and blank its
 * card; a missing start time only loses one line of detail.
 * `unitMs` is 1000 for seconds (AWS), 1 for milliseconds (Apple).
 */
export function epochToIso(value: unknown, unitMs: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const epoch = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(epoch) || epoch === 0) return undefined;
  const date = new Date(epoch * unitMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

const LOOSE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * A timestamp string from a vendor payload as an ISO string, or undefined
 * when it is missing or unreadable. A payload that wrote a time like
 * "2026-09-16 11:32", with a space and no zone, would be Invalid Date in
 * Safari where Chrome accepts it; the vendors read today send ISO already,
 * so this is a guard, and the browser only ever receives ISO 8601. A value
 * without a zone is read as UTC.
 */
export function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const loose = LOOSE_TIMESTAMP.exec(text);
  let candidate = text;
  if (loose) {
    const zone = loose[3] ?? "Z";
    const offset = /^[+-]\d{4}$/.test(zone) ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone.toUpperCase();
    candidate = `${loose[1]}T${loose[2]}${offset}`;
  }
  const date = new Date(candidate);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

// What one impacted service of a multi-service event contributes. AWS
// reports `current` as 0 (recovered), 1 (informational), 2 (performance
// issue) or 3 (service disruption). Recovered services contribute no row. A
// disruption is an outage wherever it is (the vendor's word, not the
// region's); the milder levels are Degraded, or Maintenance during
// maintenance. A missing reading keeps the event's own health.
function awsImpactedHealth(current: unknown, eventHealth: Health): Health | null {
  const level = awsLevel(current);
  if (level === 0) return null;
  if (level === 3) return "outage";
  if (level === 1 || level === 2) return eventHealth === "maintenance" ? "maintenance" : "degraded";
  return eventHealth;
}

const AWS_GENERIC_NAME = /^multiple services?$/i;

// The services an event names that are not recovered, each with its health.
// A multi-service event (`impacted_services`) names each service it affects;
// any other event names its own `service_name`. "Multiple services" is a
// placeholder for the first case, never a service.
function awsEventServices(event: AwsEvent): Array<{ name: string; health: Health }> {
  const eventHealth = awsHealthFromEvent(event);
  const impacted = Object.values(event.impacted_services ?? {}).filter(
    (entry) => typeof entry?.service_name === "string" && entry.service_name.trim() !== "",
  );
  if (impacted.length > 0) {
    const named: Array<{ name: string; health: Health }> = [];
    for (const entry of impacted) {
      const health = awsImpactedHealth(entry.current, eventHealth);
      if (health) named.push({ name: (entry.service_name as string).trim(), health });
    }
    return named;
  }
  const name = (event.service_name ?? event.service ?? "").trim();
  return name && !AWS_GENERIC_NAME.test(name) ? [{ name, health: eventHealth }] : [];
}

/**
 * An event's health. With per-service readings (`impacted_services`) it is
 * the worst of the services still affected; otherwise, or when every one has
 * recovered, it is the event's own (see `awsHealthFromEvent`).
 */
function awsEventHealth(event: AwsEvent): Health {
  const services = awsEventServices(event);
  if (Object.keys(event.impacted_services ?? {}).length > 0 && services.length > 0) {
    return services.reduce<Health>((worst, service) => worseHealth(worst, service.health), "operational");
  }
  return awsHealthFromEvent(event);
}

/**
 * The AWS services named by active events, one component each. Several
 * events for a service merge into one row: the worst health wins, the
 * regions are the union of every event's, and the detail is the newest
 * event's summary, prefixed with those regions ("N. Virginia, Ireland ·
 * Increased API Error Rates"). Only services the events name appear, so a
 * quiet Health Dashboard yields no list; an event that names no service
 * (or only "Multiple services") cannot be a row.
 */
export function awsComponents(active: AwsEvent[]): ComponentHealth[] {
  type Row = ComponentHealth & { at: number; regions: Set<string> };
  const rows = new Map<string, Row>();
  for (const event of active) {
    const last = awsLatestLog(event);
    const at = Number(last?.timestamp ?? event.date ?? 0) || 0;
    const summary = event.summary || last?.summary || undefined;
    const region = (event.region_name ?? "").trim();
    for (const { name, health } of awsEventServices(event)) {
      const row = rows.get(name);
      if (!row) {
        rows.set(name, { name, health, detail: summary, at, regions: new Set(region ? [region] : []) });
        continue;
      }
      row.health = worseHealth(row.health, health);
      // Every event's region counts, whichever summary is shown.
      if (region) row.regions.add(region);
      if (at >= row.at) {
        row.at = at;
        row.detail = summary ?? row.detail;
      }
    }
  }
  return [...rows.values()].map(({ name, health, detail, regions }) => {
    const text = [regions.size ? [...regions].join(", ") : "", detail ?? ""].filter(Boolean).join(" · ");
    return text ? { name, health, detail: text } : { name, health };
  });
}

/**
 * What an incident title names as the affected service. A "Multiple
 * services" event is named by the services it still affects (one or two by
 * name, more than that as a count).
 */
export function awsEventSubject(event: AwsEvent): string {
  const own = (event.service_name ?? event.service ?? "").trim();
  if (own && !AWS_GENERIC_NAME.test(own)) return own;
  const names = [...new Set(awsEventServices(event).map((service) => service.name))];
  if (names.length === 0) return own ? "Multiple AWS services" : "AWS";
  return names.length <= 2 ? names.join(" and ") : `${names.length} AWS services`;
}

/** "Service (Region) — summary". */
export function awsIncidentTitle(event: AwsEvent): string {
  const region = (event.region_name ?? "").trim();
  const summary = event.summary ?? awsLatestLog(event)?.summary ?? "Event";
  return `${awsEventSubject(event)}${region ? ` (${region})` : ""} — ${summary}`;
}

async function collectAws(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() =>
      fetchJson<AwsEvent[]>("https://health.aws.amazon.com/public/currentevents", { binary: true }),
    );
    const now = Date.now();
    const active = value.filter((event) => awsEventActive(event, now));
    let health: Health = "operational";
    const { incidents, problems, incidentCount } = listIncidents(
      active.map((event) => {
        const itemHealth = awsEventHealth(event);
        health = worseHealth(health, itemHealth);
        const last = awsLatestLog(event);
        return {
          // The ARN is the event's identity. Without one the id is built from
          // the event's own content, so it is the same on every sweep (a
          // random UUID would make each sweep look like a new incident).
          id:
            event.arn ||
            `aws-${fingerprint(
              [
                event.service_name ?? event.service ?? "",
                event.region_name ?? "",
                event.date ?? "",
                event.summary ?? "",
              ].join("|"),
            )}`,
          title: awsIncidentTitle(event),
          health: itemHealth,
          startedAt: epochToIso(event.date, 1000),
          updatedAt: epochToIso(last?.timestamp, 1000),
          url: "https://health.aws.amazon.com/health/status",
        };
      }),
    );
    return {
      ...base("aws", new Date().toISOString(), ms),
      health,
      summary: overallSummary(
        health,
        problems,
        incidents[0]?.title ?? `${value.length} public Health items, none currently active.`,
      ),
      ...rankComponents(awsComponents(active)),
      incidents,
      ...(incidentCount ? { incidentCount } : {}),
      meta: { publicEvents: value.length, active: active.length },
    };
  } catch (error) {
    return failed("aws", started, error);
  }
}

/**
 * How many Steam connection managers a `GetCMListForConnect` answer lists:
 * the `serverlist` entries that are objects with a non-empty string
 * `endpoint` (`{ endpoint, legacy_endpoint, type, dc, realm, load, ... }`).
 * 0 when `success` is false, the list is empty, or the payload is not that
 * shape.
 */
export function steamCmCount(payload: unknown): number {
  const response = (payload as { response?: { success?: unknown; serverlist?: unknown } } | null)?.response;
  if (!response || response.success === false || !Array.isArray(response.serverlist)) return 0;
  return response.serverlist.filter(
    (row: unknown) =>
      typeof (row as { endpoint?: unknown } | null)?.endpoint === "string" &&
      (row as { endpoint: string }).endpoint !== "",
  ).length;
}

async function collectSteam(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    // allSettled, not all: one endpoint being down should degrade the card,
    // not blank it. Only when neither answers usefully do we fail the whole
    // collector, and with the real error rather than a generic outage.
    // The card's latency is the two health requests only: the side request
    // for the connection managers has its own, longer, deadline.
    let mainMs = 0;
    const timeMain = <T>(request: Promise<T>) =>
      request.finally(() => {
        mainMs = Math.max(mainMs, Date.now() - started);
      });
    const [info, store, cm] = await Promise.allSettled([
      timeMain(
        fetchJson<{ servertime?: unknown } | null>("https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/"),
      ),
      timeMain(fetchJson<{ featured_win?: unknown } | null>("https://store.steampowered.com/api/featured/")),
      // Side signal: it never decides the card's health or whether it fails.
      fetchJson<unknown>("https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=0", {
        timeoutMs: EXTRA_TIMEOUT_MS,
      }),
    ]);
    const servertime = info.status === "fulfilled" ? info.value?.servertime : undefined;
    const apiOk = typeof servertime === "number";
    const storeOk = store.status === "fulfilled" && Array.isArray(store.value?.featured_win);
    if (!apiOk && !storeOk) {
      // Name the real fault: a refusal is only reported when nothing else went wrong.
      const rejections = [info, store].flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
      const real = rejections.find((reason) => !isRefusal(reason));
      if (real !== undefined) throw real;
      if (info.status === "fulfilled" || store.status === "fulfilled") {
        throw new PayloadError("Steam Web API and Store answered in an unexpected shape.");
      }
      throw rejections[0];
    }
    // The half that failed says why on its component, so a Degraded card is
    // never left without a reason. A probe the vendor refused (403, 429, a bot
    // challenge) proves nothing about the service, so it is Unknown and does not
    // count against the card; only a probe that really failed does.
    const probe = (name: string, ok: boolean, result: PromiseSettledResult<unknown>): ComponentHealth => {
      if (ok) return { name, health: "operational" };
      if (result.status === "rejected") {
        if (isRefusal(result.reason)) {
          const label = name.replace(/^Steam /, "");
          return { name, health: "unknown", detail: `${label} refused the check (${result.reason.status})` };
        }
        return { name, health: "outage", detail: classifyFailure(result.reason).message };
      }
      return { name, health: "outage", detail: "Unexpected response shape." };
    };
    const components: ComponentHealth[] = [probe("Steam Web API", apiOk, info), probe("Steam Store", storeOk, store)];
    const health: Health = components.some((c) => c.health === "outage") ? "degraded" : "operational";
    // A side list: when the directory cannot be read, or lists nothing, the
    // row is left out rather than shown as Unknown.
    const managers = cm.status === "fulfilled" ? steamCmCount(cm.value) : 0;
    if (managers > 0) {
      components.push({
        name: "Steam Connection Managers",
        health: "operational",
        detail: `${managers} server${managers === 1 ? "" : "s"} listed`,
      });
    }
    return {
      ...base("steam", new Date().toISOString(), mainMs),
      health,
      summary: overallSummary(health, 0),
      components,
      incidents: [],
      meta: { servertime: apiOk ? servertime : 0 },
    };
  } catch (error) {
    return failed("steam", started, error);
  }
}

function isEuropePop(code: string, desc: string, geo?: number[]): boolean {
  if (EU_POPS.has(code.toLowerCase())) return true;
  if (/(netherlands|germany|finland|england|spain|france|sweden|austria|poland|europe)/i.test(desc)) {
    return true;
  }
  if (!geo || geo.length < 2) return false;
  const [lon, lat] = geo;
  return lat >= 35 && lat <= 72 && lon >= -25 && lon <= 45;
}

async function collectCs2Europe(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    // The player count is a nice-to-have, not part of the health signal: a
    // failure or an unreadable body here must never take the whole card
    // down, so it is caught locally and simply omitted.
    const [sdr, players] = await Promise.all([
      timed(() => fetchJson<SteamSdr>("https://api.steampowered.com/ISteamApps/GetSDRConfig/v1/?appid=730")),
      timed(() =>
        fetchJson<{ response?: { player_count?: number; result?: number } }>(
          "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=730",
        ),
      ).catch(() => null),
    ]);
    const ms = Math.max(sdr.ms, players?.ms ?? 0);
    const pops = sdr.value.pops ?? {};
    const europe = Object.entries(pops)
      .filter(([code, pop]) => isEuropePop(code, pop.desc ?? "", pop.geo))
      .map(([code, pop]) => ({
        code,
        desc: pop.desc ?? code,
        relays: pop.relays?.length ?? 0,
      }))
      .sort((a, b) => a.desc.localeCompare(b.desc));

    const withRelays = europe.filter((pop) => pop.relays > 0);
    const silent = europe.filter((pop) => pop.relays === 0);
    const playerCount = players?.value?.response?.player_count;
    let health: Health = "operational";
    if (!sdr.value.success || europe.length === 0) health = "outage";
    // Fewer than 3, or fewer than 40%, of the European pops publish relays.
    // Cross-multiplied to avoid `Math.floor` quietly loosening the 40% bar
    // for pop counts that are not a multiple of 5.
    else if (withRelays.length < 3 || withRelays.length * 5 < europe.length * 2) health = "degraded";

    const components: ComponentHealth[] = withRelays.map((pop) => ({
      name: pop.desc,
      health: "operational" as Health,
      detail: `${pop.relays} relay${pop.relays === 1 ? "" : "s"}`,
    }));
    if (silent.length) {
      components.push({
        name: "Unpublished pops",
        health: "operational",
        detail: silent.map((pop) => pop.code.toUpperCase()).join(", "),
      });
    }

    const summary =
      health === "operational"
        ? `${withRelays.length}/${europe.length} EU datagram pops publishing relays${
            typeof playerCount === "number" ? ` · ${playerCount.toLocaleString("en-US")} playing CS2` : ""
          }.`
        : "Europe CS2 datagram coverage looks thin or unavailable.";

    return {
      ...base("cs2-europe", new Date().toISOString(), ms),
      health,
      summary,
      components,
      incidents: [],
      meta: {
        euPops: europe.length,
        euWithRelays: withRelays.length,
        players: typeof playerCount === "number" ? playerCount : 0,
      },
    };
  } catch (error) {
    return failed("cs2-europe", started, error);
  }
}

// State shared by the collectors of one collectAllServices() call, and
// only that call: the next sweep starts empty, so nothing here can serve a
// stale payload.
type Sweep = {
  epicSummary: () => Promise<{ value: StatuspageSummary; ms: number }>;
};

function createSweep(): Sweep {
  let epic: Promise<{ value: StatuspageSummary; ms: number }> | undefined;
  return {
    // Epic and Fortnite are two cards cut from one Statuspage summary, so
    // one sweep fetches it once and both read the same answer (or the same
    // failure). The bytes count toward whichever collector asked first.
    epicSummary: () =>
      (epic ??= timed(() => fetchJson<StatuspageSummary>("https://status.epicgames.com/api/v2/summary.json"))),
  };
}

// Fortnite is any component named for it, or sitting in a group named for it:
// on status.epicgames.com the group's children have plain names (Login,
// Matchmaking). Epic is everything else.
function isFortnite(name: string, groupName?: string): boolean {
  return /fortnite/i.test(name) || (groupName !== undefined && /fortnite/i.test(groupName));
}

async function collectEpic(sweep: Sweep): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await sweep.epicSummary();
    return fromStatuspage("epic", value, ms, (name, groupName) => !isFortnite(name, groupName));
  } catch (error) {
    return failed("epic", started, error);
  }
}

async function collectFortnite(sweep: Sweep): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await sweep.epicSummary();
    return fromStatuspage("fortnite", value, ms, isFortnite);
  } catch (error) {
    return failed("fortnite", started, error);
  }
}

async function collectSpotify(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() =>
      fetchJson<StatuspageSummary>("https://spotify.statuspage.io/api/v2/summary.json"),
    );
    return fromStatuspage("spotify", value, ms);
  } catch (error) {
    return failed("spotify", started, error);
  }
}

// Only events that are happening now have a health. An "upcoming" one has
// not started, so it must not make the service read Maintenance hours
// before it begins: it is kept as upcomingMaintenance instead.
function appleEventHealth(event: { eventStatus?: string; statusType?: string }): Health {
  const status = (event.eventStatus ?? "").toLowerCase();
  const type = (event.statusType ?? "").toLowerCase();
  if (status !== "ongoing" && status !== "current") return "operational";
  if (type === "outage") return "outage";
  if (type === "maintenance") return "maintenance";
  return "degraded";
}

function appleEventUpcoming(event: { eventStatus?: string }): boolean {
  return (event.eventStatus ?? "").toLowerCase() === "upcoming";
}

async function collectApple(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() =>
      fetchJson<AppleStatus>("https://www.apple.com/support/systemstatus/data/system_status_en_US.js"),
    );
    let health: Health = "operational";
    const incidents: Incident[] = [];
    const components: ComponentHealth[] = [];
    const upcoming: UpcomingMaintenance[] = [];
    for (const service of value.services ?? []) {
      const events = service.events ?? [];
      for (const event of events.filter(appleEventUpcoming)) {
        upcoming.push({
          id: `${service.serviceName}-${event.epochStartDate ?? event.datePosted ?? event.message}`,
          title: `${service.serviceName}: ${event.message ?? event.statusType ?? "Scheduled maintenance"}`,
          scheduledFor: epochToIso(event.epochStartDate, 1),
          scheduledUntil: epochToIso(event.epochEndDate, 1),
          url: "https://www.apple.com/support/systemstatus/",
        });
      }
      const active = events.filter((event) => appleEventHealth(event) !== "operational");
      if (!active.length) {
        // The payload lists every service, quiet or not, so a healthy one is a
        // real operational component rather than an invented row.
        if (service.serviceName) components.push({ name: service.serviceName, health: "operational" });
        continue;
      }
      for (const event of active) {
        const itemHealth = appleEventHealth(event);
        health = worseHealth(health, itemHealth);
        components.push({ name: service.serviceName, health: itemHealth, detail: event.message });
        incidents.push({
          id: `${service.serviceName}-${event.epochStartDate ?? event.datePosted ?? event.message}`,
          title: `${service.serviceName}: ${event.message ?? event.statusType ?? "Issue"}`,
          health: itemHealth,
          startedAt: epochToIso(event.epochStartDate, 1),
          url: "https://www.apple.com/support/systemstatus/",
        });
      }
    }
    const { incidents: sorted, problems, incidentCount } = listIncidents(incidents);
    return {
      ...base("apple", new Date().toISOString(), ms),
      health,
      summary: overallSummary(health, problems, sorted[0]?.title),
      ...rankComponents(components),
      incidents: sorted,
      ...(incidentCount ? { incidentCount } : {}),
      ...(upcoming.length ? { upcomingMaintenance: soonest(upcoming, MAX_UPCOMING_MAINTENANCE) } : {}),
      meta: { services: value.services?.length ?? 0 },
    };
  } catch (error) {
    return failed("apple", started, error);
  }
}

// Only strip comments and things that look like tags (`<` or `</` followed by
// a letter). A blanket `<[^>]+>` also ate a decoded "Latency < 500ms", which
// erased "Status: Resolved" from an otherwise operational item. Plain text
// such as "a<b ... c>d" still reads as a tag; regex stripping cannot tell.
//
// A single pass over the `<` positions rather than a regex: `<!--[\s\S]*?-->`
// rescans to the end of the text from every unclosed `<!--`, which is
// quadratic on a body of repeated openers. Here a missing "-->" is looked
// for once, and a tag body stops at the next `<` or `>`, so nothing is
// scanned twice.
function stripMarkup(value: string): string {
  let out = "";
  let from = 0;
  let commentsClose = true;
  for (;;) {
    const lt = value.indexOf("<", from);
    if (lt === -1) return out + value.slice(from);
    out += value.slice(from, lt);
    from = lt + 1;
    if (value.startsWith("<!--", lt)) {
      const end = commentsClose ? value.indexOf("-->", lt + 4) : -1;
      if (end !== -1) {
        out += " ";
        from = end + 3;
        continue;
      }
      commentsClose = false;
      out += "<";
      continue;
    }
    let at = lt + 1;
    if (value[at] === "/") at += 1;
    if (isAsciiLetter(value.charCodeAt(at))) {
      at += 1;
      while (at < value.length && value[at] !== "<" && value[at] !== ">") at += 1;
      if (value[at] === ">") {
        out += " ";
        from = at + 1;
        continue;
      }
    }
    out += "<";
  }
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function stripHtml(value: string): string {
  return stripMarkup(value)
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const XML_NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

// Matches the five predefined XML entities plus decimal and hex numeric
// character references. A single pass with a replacer keeps `&amp;lt;` as
// `&lt;` rather than double-decoding it into `<`: once `&amp;` becomes `&`,
// the regex has already moved past it and never re-scans the result.
const XML_ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

export function decodeXmlEntities(text: string): string {
  return text.replace(XML_ENTITY_RE, (match, body: string) => {
    if (body[0] === "#") {
      // The regex's numeric branch only ever produces a lowercase "x", so
      // there is no uppercase case to handle here.
      const isHex = body[1] === "x";
      const digits = isHex ? body.slice(2) : body.slice(1);
      const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
      // Reject out-of-range values, lone surrogate halves, and the
      // characters XML forbids outright (C0 controls other than tab/LF/CR,
      // and the two permanently-unassigned noncharacters) rather than let
      // String.fromCodePoint throw or silently emit U+FFFD. `digits` is
      // always non-negative, so there is no `codePoint < 0` case either.
      if (
        !Number.isFinite(codePoint) ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        (codePoint < 0x20 && codePoint !== 0x9 && codePoint !== 0xa && codePoint !== 0xd) ||
        codePoint === 0xfffe ||
        codePoint === 0xffff
      ) {
        return match;
      }
      return String.fromCodePoint(codePoint);
    }
    return XML_NAMED_ENTITIES[body] ?? match;
  });
}

// CDATA content is already literal text, so it must never be re-decoded
// (`<![CDATA[a &amp; b]]>` should stay `a &amp; b`). Split on CDATA sections
// and decode only the parts outside them. Found with indexOf rather than a
// lazy regex, which rescans to the end from every unclosed opener.
const CDATA_START = "<![CDATA[";
const CDATA_END = "]]>";

export function decodeXmlField(raw: string): string {
  let result = "";
  let from = 0;
  for (;;) {
    const start = raw.indexOf(CDATA_START, from);
    if (start === -1) return result + decodeXmlEntities(raw.slice(from));
    result += decodeXmlEntities(raw.slice(from, start));
    const end = raw.indexOf(CDATA_END, start + CDATA_START.length);
    // An opener with no closing `]]>` anywhere later: treat everything from
    // that marker onward as literal CDATA content (strip the marker, leave
    // the rest undecoded), rather than decoding text the feed meant to be
    // taken as-is.
    if (end === -1) return result + raw.slice(start + CDATA_START.length);
    result += raw.slice(start + CDATA_START.length, end);
    from = end + CDATA_END.length;
  }
}

/** Most `<item>`s kept from a feed: the newest by pubDate. Real feeds carry tens. */
export const MAX_RSS_ITEMS = 200;
/**
 * Most `<item>`s read in one feed. status.x.ai serves its whole history and
 * nothing says which end is newest, so every item up to this bound is dated
 * before the newest MAX_RSS_ITEMS are chosen. The bound is for memory, and a
 * feed with more items than this is refused (a PayloadError, so its card is
 * unknown): the items past it could be the current incident, and reading only
 * the others would be an all-clear built on a guess.
 */
export const MAX_RSS_SCANNED = 5000;

const ITEM_CLOSE = /<\/item>/i;

const FIELD_TAGS = new Map<string, [RegExp, RegExp]>();

// The text between the first `<tag>` and the first `</tag>` after it, or
// undefined. Two literal searches, so a field is read in one pass over its
// item whatever the item holds; `<tag>([\s\S]*?)</tag>` rescanned the whole
// item from every repeated, unclosed `<tag>`.
function xmlField(chunk: string, tag: string): string | undefined {
  let tags = FIELD_TAGS.get(tag);
  if (!tags) {
    tags = [new RegExp(`<${tag}>`, "i"), new RegExp(`</${tag}>`, "i")];
    FIELD_TAGS.set(tag, tags);
  }
  const open = chunk.search(tags[0]);
  if (open === -1) return undefined;
  const from = open + tag.length + 2;
  const close = chunk.slice(from).search(tags[1]);
  return close === -1 ? undefined : chunk.slice(from, from + close);
}

export function parseRssItems(
  xml: string,
): Array<{ title: string; description: string; pubDate?: string; link?: string }> {
  // Each item runs from its `<item>` to the next one, cut at its own
  // `</item>`; every search below stays inside that slice, so the whole feed
  // is read once. Only the date is read from all of the items scanned; the
  // newest MAX_RSS_ITEMS are then read in full, before anything downstream
  // maps or sorts them. An item with no readable date ranks last, and ties
  // keep the feed's order. The items kept stay in the feed's order.
  const scanned: Array<{ chunk: string; at: number; index: number }> = [];
  const itemOpen = /<item[\s>]/gi;
  let open = itemOpen.exec(xml);
  while (open && scanned.length < MAX_RSS_SCANNED) {
    const bodyStart = open.index + open[0].length;
    const next = itemOpen.exec(xml);
    const block = xml.slice(bodyStart, next ? next.index : xml.length);
    const closed = block.search(ITEM_CLOSE);
    const chunk = closed === -1 ? block : block.slice(0, closed);
    const date = Date.parse(xmlField(chunk, "pubDate")?.trim() ?? "");
    scanned.push({ chunk, at: Number.isFinite(date) ? date : Number.NEGATIVE_INFINITY, index: scanned.length });
    open = next;
  }
  if (open) throw new PayloadError(`RSS feed has more than ${MAX_RSS_SCANNED} items.`);
  const kept =
    scanned.length > MAX_RSS_ITEMS
      ? scanned
          .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at > b.at ? -1 : 1))
          .slice(0, MAX_RSS_ITEMS)
          .sort((a, b) => a.index - b.index)
      : scanned;
  return kept.map(({ chunk }) => {
    const title = decodeXmlField(xmlField(chunk, "title") ?? "").trim();
    const description = decodeXmlField(xmlField(chunk, "description") ?? "").trim();
    const pubDate = xmlField(chunk, "pubDate")?.trim();
    const rawLink = xmlField(chunk, "link");
    const link = rawLink !== undefined ? decodeXmlField(rawLink).trim() : undefined;
    return { title, description, pubDate, link };
  });
}

export function grokItemHealth(description: string): Health {
  const text = stripHtml(description).toLowerCase();
  if (text.includes("status: resolved") || text.includes("severity: available")) return "operational";
  // `\bmajor\b` so "majority of requests" is not read as a major outage.
  if (text.includes("outage") || /\bmajor\b/.test(text)) return "outage";
  if (text.includes("maintenance")) return "maintenance";
  return "degraded";
}

// status.x.ai serves its whole incident history in one feed, so an item is
// only evidence about right now if it is recent. An item with no parseable
// pubDate cannot be shown to be current; AWS drops undated events the same way.
export function grokItemActive(item: { description: string; pubDate?: string }, now: number): boolean {
  if (grokItemHealth(item.description) === "operational") return false;
  const at = item.pubDate ? Date.parse(item.pubDate) : Number.NaN;
  return isRecent(at, now);
}

/**
 * Components from an Instatus `components.json`: the leaf components in page
 * order (a component with children is replaced by them, at any depth), or
 * nothing when the payload is not that shape. The endpoint is optional, so a
 * shape it does not have is an empty list, not an error.
 */
export function parseInstatusComponents(payload: unknown): ComponentHealth[] {
  const list = (payload as { components?: unknown } | null)?.components;
  if (!Array.isArray(list)) return [];
  type Row = { name?: unknown; status?: unknown; description?: unknown; children?: unknown };
  const out: ComponentHealth[] = [];
  const walk = (rows: Row[], depth: number) => {
    for (const row of rows) {
      if (Array.isArray(row?.children) && row.children.length > 0 && depth < 8) {
        walk(row.children as Row[], depth + 1);
        continue;
      }
      const name = typeof row?.name === "string" ? row.name.trim() : "";
      if (!name) continue;
      const health = instatusComponent(typeof row.status === "string" ? row.status : undefined);
      const description = typeof row.description === "string" ? row.description.trim() : "";
      out.push(description && health !== "operational" ? { name, health, detail: description } : { name, health });
    }
  };
  walk(list as Row[], 0);
  return out;
}

/**
 * The service a feed title leads with. status.x.ai writes titles as
 * "[Service] summary", such as "[Grok (iOS)] Models outage" or
 * "[API (us-east-1.api.x.ai)] Models outage"; the whole bracket text is the
 * service. A title without that lead names no service, and none is guessed.
 */
export function grokTitleService(title: string): { name: string; detail: string } | null {
  // `(\S.*)`, not `\s*(.+)`: with both able to match spaces, a title holding a
  // line break after a long run of them backtracked quadratically.
  const match = title.match(/^\[([^\]]{1,64})\]\s*(\S.*)$/);
  const name = match?.[1]?.trim();
  const detail = match?.[2]?.trim();
  return name && detail ? { name, detail } : null;
}

/** One component per service the active items' titles lead with; worst health wins, newest item's detail. */
export function grokFeedComponents(
  active: Array<{ title: string; description: string; pubDate?: string }>,
): ComponentHealth[] {
  const rows = new Map<string, ComponentHealth & { at: number }>();
  for (const item of active) {
    const service = grokTitleService(item.title);
    if (!service) continue;
    const health = grokItemHealth(item.description);
    const at = Date.parse(item.pubDate ?? "") || 0;
    const key = service.name.toLowerCase();
    const row = rows.get(key);
    if (!row) {
      rows.set(key, { name: service.name, health, detail: service.detail, at });
      continue;
    }
    row.health = worseHealth(row.health, health);
    if (at >= row.at) {
      row.at = at;
      row.detail = service.detail;
    }
  }
  return [...rows.values()].map(({ name, health, detail }) => ({ name, health, detail }));
}

async function collectGrok(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    // status.x.ai's JSON sits behind a Cloudflare challenge more often than
    // not, so the optional Instatus component list is a side request that
    // runs beside the feed and is simply absent when it does not answer.
    const [{ value, ms }, instatus] = await Promise.all([
      timed(() => fetchText("https://status.x.ai/feed.xml")),
      fetchJson<unknown>("https://status.x.ai/v2/components.json", { timeoutMs: EXTRA_TIMEOUT_MS }).catch(() => null),
    ]);
    const items = parseRssItems(value.body);
    // parseRssItems only understands RSS 2.0 <item>. If x.ai moves to Atom
    // the parse yields nothing, and reporting that as "operational" would be
    // a confident all-clear built on no data. Unknown is the honest answer.
    if (items.length === 0) throw new PayloadError("Grok feed returned no readable items.");
    const now = Date.now();
    const active = items.filter((item) => grokItemActive(item, now));
    // A list whose every status is unreadable says nothing: ignore it.
    const parsed = parseInstatusComponents(instatus);
    const listed = parsed.some((component) => component.health !== "unknown") ? parsed : [];
    // Health covers every active item, though only the first 8 are listed
    // as incidents, so the card is never better than its worst component row.
    const health = active.reduce<Health>(
      (worst, item) => worseHealth(worst, grokItemHealth(item.description)),
      "operational",
    );
    // Sorted worst first before the first 8 are kept, so the cut never drops
    // the most urgent item.
    const { incidents, problems, incidentCount } = listIncidents(
      active.map((item, index) => ({
        id: item.link ?? `${item.title}-${index}`,
        title: item.title,
        health: grokItemHealth(item.description),
        startedAt: isoTimestamp(item.pubDate),
        url: vendorUrl(item.link, CATALOG_BY_ID.grok.sourceUrl, [hostOf(CATALOG_BY_ID.grok.sourceUrl)]),
      })),
      8,
    );
    return {
      ...base("grok", new Date().toISOString(), ms),
      health,
      summary: overallSummary(health, problems, incidents[0]?.title),
      // The vendor's own list when it is readable; otherwise only the
      // services the current feed's titles name. Health above is the feed's
      // alone: components add detail and never move it.
      ...rankComponents(listed.length ? listed : grokFeedComponents(active)),
      incidents,
      ...(incidentCount ? { incidentCount } : {}),
    };
  } catch (error) {
    return failed("grok", started, error);
  }
}

// GitHub and Confluence each publish a Statuspage of their own, so they are
// the Spotify collector with a different address. Each fetches the vendor's
// own host only (http.ts refuses a redirect off it). GitLab is not here: its
// page runs on Status.io, which has no Statuspage API (see collectGitlab).
const STATUSPAGE_SUMMARIES = {
  github: "https://www.githubstatus.com/api/v2/summary.json",
  confluence: "https://confluence.status.atlassian.com/api/v2/summary.json",
} as const;

// A page's own pointer to itself ("Visit www.githubstatus.com for more
// information") is listed by the vendor as a component. It is not a service,
// and as a row it would read Operational and count as a working component.
const NOT_A_SERVICE = /^Visit /;

async function collectStatuspage(id: keyof typeof STATUSPAGE_SUMMARIES): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() => fetchJson<StatuspageSummary>(STATUSPAGE_SUMMARIES[id]));
    if (value && Array.isArray(value.components)) {
      // Cut before the filter, as records() does, so the pass is bounded too.
      value.components = value.components
        .slice(0, MAX_SCANNED_ROWS)
        .filter((component) => !(typeof component?.name === "string" && NOT_A_SERVICE.test(component.name)));
    }
    return fromStatuspage(id, value, ms);
  } catch (error) {
    return failed(id, started, error);
  }
}

// status.gitlab.com is a Status.io page. Status.io publishes no Statuspage
// `api/v2` for it; its public status API takes the page's id.
const GITLAB_STATUS_URL = "https://api.status.io/1.0/status/5b36dc6502d06804c08349f7";
const GITLAB_PAGE_ID = "5b36dc6502d06804c08349f7";

/** The newest message of a Status.io event by its datetime; with none readable, the last listed. */
function newestStatusIoMessage(event: StatusIoEvent): StatusIoMessage | undefined {
  const messages = records<StatusIoMessage>(event.messages, MAX_NESTED_ROWS);
  let newest: StatusIoMessage | undefined;
  let newestAt = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    const at = typeof message.datetime === "string" ? Date.parse(message.datetime) : Number.NaN;
    const value = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
    if (newest === undefined || value >= newestAt) {
      newest = message;
      newestAt = value;
    }
  }
  return newest;
}

/**
 * A card from Status.io's public status API reply. The page's own
 * `status_overall.status_code` is the health (100 operational, 200
 * maintenance, 300/400/600 degraded, 500 outage; see statusIoHealth); a reply
 * without a readable one is not a status and is a parser failure, never an
 * all-clear. Components come from `status[]`, incidents from `incidents[]`
 * and maintenance from `maintenance.active[]` and `maintenance.upcoming[]`.
 * Status.io writes no link on an incident, so the link is the page's own
 * incident page, kept to the vendor's host. Each array is cut to its first
 * MAX_SCANNED_ROWS entries (MAX_NESTED_ROWS for containers and messages)
 * before anything is mapped, so a reply of a million `{}` costs no more than
 * a small one.
 */
export function fromStatusIo(id: ServiceId, data: StatusIoStatus, latencyMs: number, pageId: string): ServiceSnapshot {
  const result = data?.result;
  if (typeof result !== "object" || result === null) throw new PayloadError("Status.io reply has no result.");
  let health = statusIoHealth(result.status_overall?.status_code);
  if (health === "unknown") throw new PayloadError("Status.io reply has no readable overall status.");
  const checkedAt = new Date().toISOString();
  const { sourceUrl } = CATALOG_BY_ID[id];
  const hosts = [hostOf(sourceUrl)];
  // Vendor fields are not validated: only a string is text.
  const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
  const eventUrl = (kind: "incident" | "maintenance", event: StatusIoEvent): string | undefined => {
    const eventId = text(event._id);
    return eventId ? vendorUrl(`/pages/${kind}/${pageId}/${encodeURIComponent(eventId)}`, sourceUrl, hosts) : undefined;
  };

  const components: ComponentHealth[] = records<StatusIoComponent>(result.status).map((component) => {
    const componentHealth = statusIoHealth(component.status_code);
    const affected = records<StatusIoContainer>(component.containers, MAX_NESTED_ROWS)
      .filter((container) => statusIoHealth(container.status_code) !== "operational")
      .map((container) => text(container.name))
      .filter((name): name is string => name !== undefined);
    const detail =
      componentHealth === "operational" || componentHealth === "unknown"
        ? undefined
        : [text(component.status), affected.length ? `(${affected.join(", ")})` : ""].filter(Boolean).join(" ") ||
          undefined;
    return {
      name: text(component.name) ?? "Component",
      health: componentHealth,
      ...(detail ? { detail } : {}),
    };
  });

  const mapped: Incident[] = records<StatusIoEvent>(result.incidents).map((incident) => {
    const newest = newestStatusIoMessage(incident);
    const incidentHealth = statusIoHealth(newest?.status);
    return {
      id:
        text(incident._id) ??
        `statusio-${fingerprint(`${text(incident.name) ?? ""}|${text(incident.datetime_open) ?? ""}`)}`,
      title: text(incident.name) ?? "Incident",
      health: incidentHealth,
      // As Statuspage's impact "none": an incident whose newest update says
      // the service is operational is a notice, listed but not counted.
      ...(incidentHealth === "operational" ? { informational: true as const } : {}),
      startedAt: isoTimestamp(incident.datetime_open),
      updatedAt: isoTimestamp(newest?.datetime),
      url: eventUrl("incident", incident),
    };
  });
  // As for Statuspage: an open incident is a statement about the service in
  // its own right, so the card is never better than the worst one; one whose
  // status the vendor left out still is a problem (Degraded).
  for (const incident of mapped)
    health = worseHealth(health, incident.health === "unknown" ? "degraded" : incident.health);
  const { incidents, problems, incidentCount } = listIncidents(mapped);

  const maintenance = result.maintenance;
  const active = records<StatusIoEvent>(maintenance?.active);
  if (active.length && health === "operational") health = "maintenance";
  const upcoming: UpcomingMaintenance[] = soonest(
    records<StatusIoEvent>(maintenance?.upcoming).map((event) => ({
      id:
        text(event._id) ??
        `statusio-${fingerprint(`${text(event.name) ?? ""}|${text(event.datetime_planned_start) ?? ""}`)}`,
      title: text(event.name) ?? "Scheduled maintenance",
      scheduledFor: isoTimestamp(event.datetime_planned_start),
      scheduledUntil: isoTimestamp(event.datetime_planned_end),
      url: eventUrl("maintenance", event),
    })),
    MAX_UPCOMING_MAINTENANCE,
  );

  const hint =
    firstProblemTitle(incidents) ||
    (health === "maintenance" ? text(active[0]?.name) : undefined) ||
    text(result.status_overall?.status);
  return {
    ...base(id, checkedAt, latencyMs),
    health,
    summary: overallSummary(health, problems, hint),
    ...rankComponents(components),
    incidents,
    ...(incidentCount ? { incidentCount } : {}),
    ...(upcoming.length ? { upcomingMaintenance: upcoming } : {}),
  };
}

async function collectGitlab(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() => fetchJson<StatusIoStatus>(GITLAB_STATUS_URL));
    return fromStatusIo("gitlab", value, ms, GITLAB_PAGE_ID);
  } catch (error) {
    return failed("gitlab", started, error);
  }
}

// An Azure feed item is over when its title begins with a resolution or a post
// incident review, as Azure prefixes them ("RESOLVED - ...", "Post Incident
// Review (PIR) - ...", also "Preliminary" or "Final" before the review). Only the title is read: "mitigated" or "restored"
// inside an active item ("partially mitigated", "restored in East US; West
// Europe remains impacted") says nothing about the whole incident being over.
// Anchored at the start, so the test is linear.
const AZURE_OVER = /^[\s[(]*(?:(?:preliminary|final)[\s-]+)?(?:resolved|mitigated|post[ -]incident review|pir)\b/i;
// An outage only when the title says so; the feed has no severity and most
// items are one service in one region.
const AZURE_OUTAGE = /\b(?:outage|service unavailable)\b/i;

/**
 * What an Azure status feed item's title says about its incident. The feed is
 * RSS 2.0 with no status field, so the reading is from the title alone,
 * case-folded: a resolution or post incident review prefix means it is over
 * ("operational"), "outage" or "service unavailable" means "outage",
 * "maintenance" means "maintenance", and anything else the feed still lists is
 * "degraded". Two anchored or bounded regexes and a substring test, so the
 * cost is linear in the text.
 */
export function azureItemHealth(title: string): Health {
  if (AZURE_OVER.test(title)) return "operational";
  if (AZURE_OUTAGE.test(title)) return "outage";
  if (title.toLowerCase().includes("maintenance")) return "maintenance";
  return "degraded";
}

const AZURE_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// The words a window's start and end follow in an item's text. Each is read
// from the 60 characters after the first of its words that is followed by a
// moment; ordinary prose ("end users", "unable to start") is skipped past.
const AZURE_START = /\b(?:start(?:s|ing)?(?: time)?|begin(?:s|ning)?)\b/i;
const AZURE_END = /\b(?:end(?:s|ing)?(?: time)?|until|finish(?:es|ing)?)\b/i;
// A zone with an offset after it ("UTC+02:00", "GMT+5:30") is not UTC, and the
// offset is not applied, so it reads as no moment.
const AZURE_CLOCK = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s?(?:utc|gmt|z)\b(?![+\-\u2212]\s?\d)/i;
const AZURE_DAY_FIRST = /\b(\d{1,2})(?:st|nd|rd|th)?\s([a-z]{3,9})\.?,?\s(\d{4})\b/i;
const AZURE_MONTH_FIRST = /\b([a-z]{3,9})\.?\s(\d{1,2})(?:st|nd|rd|th)?,?\s(\d{4})\b/i;
const AZURE_ISO_DAY = /\b(\d{4})-(\d{2})-(\d{2})\b/;

/**
 * The moment a snippet of an Azure item's text names, in ms, or undefined. It
 * needs a clock time with an explicit UTC, GMT or Z zone and a calendar day
 * ("01:00 UTC on 05 Oct 2026", "2026-10-05 01:00 UTC", "October 5, 2026 01:00
 * UTC"); a day with no zone, or a zone-less time, is left unread, since a guess
 * would put a time on the card the vendor never gave. Bounded patterns on a
 * snippet of at most 60 characters, so the cost is constant.
 */
function azureMoment(snippet: string): number | undefined {
  const clock = AZURE_CLOCK.exec(snippet);
  if (!clock) return undefined;
  let year: number;
  let month: number;
  let day: number;
  const iso = AZURE_ISO_DAY.exec(snippet);
  const dayFirst = AZURE_DAY_FIRST.exec(snippet);
  const monthFirst = AZURE_MONTH_FIRST.exec(snippet);
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])];
  } else if (dayFirst && AZURE_MONTHS.includes(dayFirst[2].slice(0, 3).toLowerCase())) {
    [year, month, day] = [
      Number(dayFirst[3]),
      AZURE_MONTHS.indexOf(dayFirst[2].slice(0, 3).toLowerCase()),
      Number(dayFirst[1]),
    ];
  } else if (monthFirst && AZURE_MONTHS.includes(monthFirst[1].slice(0, 3).toLowerCase())) {
    [year, month, day] = [
      Number(monthFirst[3]),
      AZURE_MONTHS.indexOf(monthFirst[1].slice(0, 3).toLowerCase()),
      Number(monthFirst[2]),
    ];
  } else {
    return undefined;
  }
  const hour = Number(clock[1]);
  const minute = Number(clock[2]);
  if (hour > 23 || minute > 59 || month < 0 || month > 11 || day < 1 || day > 31) return undefined;
  const at = Date.UTC(year, month, day, hour, minute);
  // Date.UTC rolls 31 Feb into March; a day that is not on the calendar is unread.
  return new Date(at).getUTCDate() === day ? at : undefined;
}

/**
 * The window an Azure item's text gives, in ms: when it starts and, if it
 * says, when it ends. The feed has no field for it, so it is read from the
 * item's text ("Starting at 01:00 UTC on 05 Oct 2026"), and only the start is
 * required. Nothing found is an empty window, never a guessed one.
 */
export function azureMaintenanceWindow(description: string | undefined): { start?: number; end?: number } {
  const body = stripHtml(description ?? "");
  // The moment in the 60 characters after a keyword match, up to the other
  // keyword. A match whose text names none gives way to the next match.
  const momentAfter = (found: RegExpMatchArray, other: RegExp): number | undefined => {
    const from = (found.index ?? 0) + found[0].length;
    const snippet = body.slice(from, from + 60);
    const cut = snippet.search(other);
    return azureMoment(cut > 0 ? snippet.slice(0, cut) : snippet);
  };
  const startWords = [...body.matchAll(new RegExp(AZURE_START.source, "gi"))];
  const endWords = [...body.matchAll(new RegExp(AZURE_END.source, "gi"))];
  let startedAt = -1;
  let start: number | undefined;
  for (const found of startWords) {
    start = momentAfter(found, AZURE_END);
    if (start !== undefined) {
      startedAt = (found.index ?? 0) + found[0].length;
      break;
    }
  }
  // The end is looked for after the start, so a word in the prose ahead of the
  // window ("end users") cannot take it; one listed before the start is the
  // fallback, for an item that gives the end first.
  const ordered = [
    ...endWords.filter((found) => (found.index ?? 0) >= startedAt),
    ...endWords.filter((found) => (found.index ?? 0) < startedAt),
  ];
  let end: number | undefined;
  for (const found of ordered) {
    end = momentAfter(found, AZURE_START);
    if (end !== undefined) break;
  }
  return { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) };
}

// Like Grok's feed, an item is evidence about right now only when it is
// unresolved and recent; one with no readable date cannot be shown to be.
// Maintenance is different: a notice is published ahead of the work, so it
// counts only once its window, read from the item's text, has started and not
// ended. One with no readable window stays out of health rather than be
// guessed at, and the notice's own date says nothing about it.
export function azureItemActive(item: { title: string; pubDate?: string; description?: string }, now: number): boolean {
  const health = azureItemHealth(item.title);
  if (health === "operational") return false;
  if (health === "maintenance") {
    const { start, end } = azureMaintenanceWindow(item.description);
    if (start === undefined || start - now > FUTURE_SKEW_MS) return false;
    return end !== undefined ? end > now && end > start : isRecent(start, now);
  }
  const at = item.pubDate ? Date.parse(item.pubDate) : Number.NaN;
  return isRecent(at, now);
}

// A maintenance notice whose window is read and has not started: listed as
// upcoming, never as a health.
function azureItemUpcoming(item: { title: string; description?: string }, now: number): boolean {
  if (azureItemHealth(item.title) !== "maintenance") return false;
  const { start } = azureMaintenanceWindow(item.description);
  return start !== undefined && start - now > FUTURE_SKEW_MS;
}

// The feed Microsoft documents for Azure status. Its host is a subdomain of
// the card's, so item links on it pass vendorUrl too.
const AZURE_FEED_URL = "https://rssfeed.azure.status.microsoft/en-us/status/feed/";

async function collectAzure(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() => fetchText(AZURE_FEED_URL));
    // A healthy Azure feed may hold no items at all, so "no items" is not a
    // failure here. A body that is not an RSS channel (an HTML error page, an
    // Atom feed) is: reading it as "operational" would be a confident
    // all-clear built on no data.
    if (!/<rss[\s>]/i.test(value.body) || !/<channel[\s>]/i.test(value.body)) {
      throw new PayloadError("Azure feed was not an RSS channel.");
    }
    const items = parseRssItems(value.body);
    const now = Date.now();
    // Items that are not over, none of which has a readable date, cannot be
    // told from current ones: a parser failure, not an all-clear.
    const open = items.filter((item) => azureItemHealth(item.title) !== "operational");
    if (open.length > 0 && !open.some((item) => Number.isFinite(Date.parse(item.pubDate ?? "")))) {
      throw new PayloadError("Azure feed items have no readable date.");
    }
    const active = items.filter((item) => azureItemActive(item, now));
    const health = active.reduce<Health>(
      (worst, item) => worseHealth(worst, azureItemHealth(item.title)),
      "operational",
    );
    const { sourceUrl } = CATALOG_BY_ID.azure;
    const upcoming: UpcomingMaintenance[] = soonest(
      items
        .filter((item) => azureItemUpcoming(item, now))
        .map((item, index) => {
          const { start, end } = azureMaintenanceWindow(item.description);
          return {
            id: item.link || `azure-${fingerprint(`${item.title}|${start ?? ""}|${index}`)}`,
            title: item.title || "Planned maintenance",
            scheduledFor: start !== undefined ? new Date(start).toISOString() : undefined,
            scheduledUntil:
              end !== undefined && start !== undefined && end > start ? new Date(end).toISOString() : undefined,
            url: vendorUrl(item.link, sourceUrl, [hostOf(sourceUrl)]),
          };
        }),
      MAX_UPCOMING_MAINTENANCE,
    );
    const { incidents, problems, incidentCount } = listIncidents(
      active.map((item, index) => {
        const health = azureItemHealth(item.title);
        // Maintenance is dated by its window: the notice went out ahead of the
        // work, and its own date would put the start weeks too early.
        const windowStart = health === "maintenance" ? azureMaintenanceWindow(item.description).start : undefined;
        const startedAt = windowStart !== undefined ? new Date(windowStart).toISOString() : isoTimestamp(item.pubDate);
        return {
          id: item.link || `azure-${fingerprint(`${item.title}|${startedAt ?? ""}|${index}`)}`,
          title: item.title || "Azure incident",
          health,
          startedAt,
          url: vendorUrl(item.link, sourceUrl, [hostOf(sourceUrl)]),
        };
      }),
    );
    return {
      ...base("azure", new Date().toISOString(), ms),
      health,
      summary: overallSummary(health, problems, incidents[0]?.title),
      components: [],
      incidents,
      ...(incidentCount ? { incidentCount } : {}),
      ...(upcoming.length ? { upcomingMaintenance: upcoming } : {}),
    };
  } catch (error) {
    return failed("azure", started, error);
  }
}

async function collectChatGpt(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() =>
      fetchJson<StatuspageSummary>("https://status.openai.com/api/v2/summary.json"),
    );
    return fromStatuspage("chatgpt", value, ms);
  } catch (error) {
    return failed("chatgpt", started, error);
  }
}

async function collectClaude(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() =>
      fetchJson<StatuspageSummary>("https://status.claude.com/api/v2/summary.json"),
    );
    return fromStatuspage("claude", value, ms);
  } catch (error) {
    return failed("claude", started, error);
  }
}

async function collectMikrotik(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(async () => {
      // Tell "nothing answered" apart from "something answered but did not
      // parse": the second is a format change that needs a code fix.
      let unparsed = 0;
      const channels = (
        await Promise.all(
          MIKROTIK_CHANNELS.map(async (channel) => {
            try {
              const { body } = await fetchText(`https://upgrade.mikrotik.com/routeros/${channel.file}`);
              const parsed = parseMikrotikNewest(body);
              if (!parsed) {
                unparsed += 1;
                return null;
              }
              return { ...channel, ...parsed };
            } catch {
              return null;
            }
          }),
        )
      ).filter((channel): channel is NonNullable<typeof channel> => Boolean(channel));
      if (!channels.length) {
        if (unparsed > 0)
          throw new PayloadError(`MikroTik answered ${unparsed} version channel(s) in an unrecognised format.`);
        throw new SourceError("MikroTik version channels did not respond.");
      }
      const stable = channels.find((channel) => channel.file === "NEWESTa7.stable");
      const newest = channels.reduce((current, channel) => {
        const currentTime = Date.parse(current.releasedAt ?? "") || 0;
        const nextTime = Date.parse(channel.releasedAt ?? "") || 0;
        return nextTime > currentTime ? channel : current;
      }, channels[0]);
      return { channels, stable, newest };
    });

    const components: ComponentHealth[] = value.channels.map((channel) => {
      const url = mikrotikChangelogUrl(channel.version);
      return {
        name: channel.name,
        health: isFreshRelease(channel.releasedAt) ? "maintenance" : "operational",
        detail: [channel.version, formatReleaseAge(channel.releasedAt)].filter(Boolean).join(" · "),
        release: {
          version: channel.version,
          ...(channel.releasedAt ? { releasedAt: channel.releasedAt } : {}),
          ...(url ? { url, linkLabel: "Release notes" } : {}),
        },
      };
    });

    // The headline is one channel's version and that same channel's date: the stable one, else the newest.
    const headline = value.stable ?? value.newest ?? value.channels[0];
    const latest = headline?.version ?? "";
    const latestDate = formatReleaseAge(headline?.releasedAt);
    // The notes of the changelogs (the newest release's first note as the summary, each version's first notes in
    // its Details) are not read here: they come after the sweep, from the cache (mikrotik-notes.server.ts), so a
    // slow or failing changelog host can never delay or change this card's result.
    const summary = latest
      ? `Latest RouterOS ${latest}${latestDate ? ` · ${latestDate}` : ""}`
      : "RouterOS channels loaded.";

    return {
      ...base("mikrotik", new Date().toISOString(), ms),
      health: "operational",
      summary,
      components,
      incidents: [],
      meta: {
        latest,
        versions: formatVersionMap(value.channels.map((channel) => ({ name: channel.name, version: channel.version }))),
      },
    };
  } catch (error) {
    return failed("mikrotik", started, error);
  }
}

async function collectAppleOs(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() => fetchText("https://developer.apple.com/news/releases/rss/releases.rss"));
    const items = parseRssItems(value.body);
    const latest = latestAppleOsByFamily(items);
    if (!latest.length) throw new PayloadError("Apple OS release feed had no OS items.");

    // Apple's feed names a release and links its page, and has no notes text of its own: the Details say so
    // rather than make some up. The link must stay on apple.com.
    const sourceUrl = CATALOG_BY_ID["apple-os"].sourceUrl;
    const components: ComponentHealth[] = latest.map((release) => {
      const { version, build } = splitAppleBuild(release.version);
      return {
        name: release.family,
        health: isFreshRelease(release.publishedAt) ? "maintenance" : "operational",
        detail: [release.version, formatReleaseAge(release.publishedAt)].filter(Boolean).join(" · "),
        release: {
          version,
          ...(build ? { build } : {}),
          ...(release.publishedAt ? { releasedAt: release.publishedAt } : {}),
          url: vendorUrl(release.link, sourceUrl, ["apple.com"]),
          // The post links the downloads and the notes; it is not the notes.
          linkLabel: "Apple Developer post",
        },
      };
    });

    const headline = [...latest].sort((a, b) => {
      const aTime = Date.parse(a.publishedAt ?? "") || 0;
      const bTime = Date.parse(b.publishedAt ?? "") || 0;
      return bTime - aTime;
    })[0];
    const summary = headline
      ? `Latest: ${headline.title}${headline.publishedAt ? ` · ${formatReleaseAge(headline.publishedAt)}` : ""}`
      : "Apple OS release feed loaded.";

    return {
      ...base("apple-os", new Date().toISOString(), ms),
      health: "operational",
      summary,
      components,
      incidents: [],
      meta: {
        latest: headline?.title ?? "",
        versions: formatVersionMap(latest.map((release) => ({ name: release.family, version: release.version }))),
      },
    };
  } catch (error) {
    return failed("apple-os", started, error);
  }
}

async function collectWindows(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() =>
      fetchText(CATALOG_BY_ID.windows.sourceUrl, { headers: { Accept: "text/html, */*" } }),
    );
    const releases = windowsReleases(readHtmlTables(value.body));
    if (!releases.length) throw new PayloadError("Windows release page had no readable version table.");

    // Only a new feature update counts as a new release: every serviced
    // version gets a monthly cumulative update, so its build (and revision date) would flag the card nearly
    // every month. The latest build stays in the detail line and the Details; the release fingerprint
    // (meta.versions) names each feature version with a fixed word, as Android's does, so it changes only when
    // the page adds a version.
    // The table gives a day, not a moment, so the dates stay bare days (UTC) and the Details read them as such.
    // It has no notes text: the Details link the page itself.
    const components: ComponentHealth[] = releases.map((release) => ({
      name: release.version,
      health: isFreshRelease(release.availableAt) ? "maintenance" : "operational",
      detail: [release.build, formatReleaseAge(windowsShippedAt(release))].filter(Boolean).join(" · "),
      release: {
        version: release.version,
        ...(release.build ? { build: release.build } : {}),
        releasedAt: release.availableAt.slice(0, 10),
        ...(release.updatedAt && release.updatedAt > release.availableAt
          ? { updatedAt: release.updatedAt.slice(0, 10) }
          : {}),
        url: CATALOG_BY_ID.windows.sourceUrl,
      },
    }));

    const headline = releases[0];
    const title = `${WINDOWS_NAME} ${headline.version}${headline.build ? ` (build ${headline.build})` : ""}`;

    return {
      ...base("windows", new Date().toISOString(), ms),
      health: "operational",
      summary: `Latest: ${title} · ${formatReleaseAge(windowsShippedAt(headline))}`,
      components,
      incidents: [],
      meta: {
        latest: title,
        versions: formatVersionMap(
          releases.map((release) => ({
            name: `${WINDOWS_NAME} ${release.version}`,
            version: "released",
          })),
        ),
      },
    };
  } catch (error) {
    return failed("windows", started, error);
  }
}

async function collectAndroidOs(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() =>
      fetchText(CATALOG_BY_ID["android-os"].sourceUrl, { headers: { Accept: "text/html, */*" } }),
    );
    const releases = androidReleases(readAndroidVersionLinks(value.body));
    if (!releases.length) throw new PayloadError("Android releases page had no readable version list.");

    // The page gives no dates, so a version is never marked fresh here: a
    // version that appears on the page is announced as a release in the
    // change feed, by the version map below, instead.
    const components: ComponentHealth[] = releases.map((release) => ({
      name: release.name,
      health: "operational",
      detail: "released",
      // The page gives no date and no notes, so the Details have only the version's own page: nothing is made up.
      // `version` is digits only (the parser checks), so the link cannot leave developer.android.com.
      release: {
        version: release.name,
        url: `https://developer.android.com/about/versions/${release.version}`,
        linkLabel: `${release.name} page`,
      },
    }));

    const headline = releases[0];
    return {
      ...base("android-os", new Date().toISOString(), ms),
      health: "operational",
      summary: `Latest: ${headline.name}`,
      components,
      incidents: [],
      meta: {
        latest: headline.name,
        versions: formatVersionMap(releases.map((release) => ({ name: release.name, version: "released" }))),
      },
    };
  } catch (error) {
    return failed("android-os", started, error);
  }
}

// Runs one collector with its own byte meter, and logs the success line
// that pairs with failed()'s collector_failed, so the log shows every
// source's latency and download size per sweep, not only the broken ones.
function metered(collect: () => Promise<ServiceSnapshot>): Promise<ServiceSnapshot> {
  return meterBytes(async (meter) => {
    // Every string a vendor sent is held to its limit here, once, whichever
    // collector built the snapshot.
    const snapshot = boundSnapshot(await collect());
    if (!snapshot.failure) {
      console.log(
        JSON.stringify({
          event: "collector_completed",
          service: snapshot.id,
          health: snapshot.health,
          latencyMs: snapshot.latencyMs,
          bytes: meter.bytes,
        }),
      );
    }
    return snapshot;
  });
}

export async function collectAllServices(): Promise<ServiceSnapshot[]> {
  const sweep = createSweep();
  return Promise.all(
    [
      collectGcp,
      collectAws,
      collectAzure,
      collectSteam,
      collectCs2Europe,
      () => collectEpic(sweep),
      () => collectFortnite(sweep),
      collectSpotify,
      collectApple,
      collectAndroid,
      () => collectStatuspage("github"),
      collectGitlab,
      () => collectStatuspage("confluence"),
      collectGrok,
      collectChatGpt,
      collectClaude,
      collectMikrotik,
      collectAppleOs,
      collectWindows,
      collectAndroidOs,
    ].map(metered),
  );
}
