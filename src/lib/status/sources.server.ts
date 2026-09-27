import { CATALOG_BY_ID } from "./catalog.ts";
import {
  formatReleaseAge,
  formatVersionMap,
  isFreshRelease,
  latestAppleOsByFamily,
  MIKROTIK_CHANNELS,
  parseMikrotikNewest,
  summarizeMikrotikChangelog,
} from "./changelog.ts";
import { fetchJson, fetchText, meteredBytes, meterBytes, PayloadError, SourceError } from "./http.ts";
import {
  googleImpact,
  overallSummary,
  statuspageComponent,
  statuspageIndicator,
  worseHealth,
} from "./health.ts";
import type {
  ComponentHealth,
  Health,
  Incident,
  ServiceId,
  ServiceSnapshot,
  SourceFailure,
} from "./types.ts";

const STALE_MS = 14 * 24 * 60 * 60 * 1000;
const EU_POPS = new Set(["ams", "fra", "fsn", "hel", "lhr", "mad", "par", "sto", "sto2", "vie", "waw"]);

type StatuspageSummary = {
  status?: { indicator?: string; description?: string };
  components?: Array<{
    id: string;
    name: string;
    status: string;
    group?: boolean;
    group_id?: string | null;
  }>;
  incidents?: Array<{
    id: string;
    name: string;
    status: string;
    impact?: string;
    shortlink?: string;
    started_at?: string;
    updated_at?: string;
  }>;
  scheduled_maintenances?: Array<{
    id: string;
    name: string;
    status: string;
    started_at?: string;
    updated_at?: string;
    shortlink?: string;
  }>;
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
};

type AwsEvent = {
  date?: string;
  arn?: string;
  region_name?: string;
  status?: string;
  service?: string;
  service_name?: string;
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

function base(id: ServiceId, checkedAt: string, latencyMs: number): Omit<
  ServiceSnapshot,
  "health" | "summary" | "components" | "incidents"
> {
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
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { kind: "parser", message };
}

function failed(id: ServiceId, started: number, error: unknown): ServiceSnapshot {
  const message = error instanceof SourceError ? error.message : "Official source did not respond.";
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
      message: failure.message,
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

function googleIncidents(incidents: GoogleIncident[], sourceRoot: string) {
  const open = incidents.filter((incident) => !incident.end);
  let health: Health = "operational";
  const components: ComponentHealth[] = [];
  const mapped: Incident[] = open.map((incident) => {
    const itemHealth = googleImpact(incident.status_impact, incident.severity);
    health = worseHealth(health, itemHealth);
    const locations = (incident.currently_affected_locations ?? [])
      .map((loc) => loc.title)
      .filter(Boolean)
      .join(", ");
    components.push({
      name: incident.service_name ?? "Service",
      health: itemHealth,
      detail: locations || incident.external_desc,
    });
    return {
      id: incident.id,
      title: incident.external_desc ?? incident.service_name ?? "Incident",
      health: itemHealth,
      startedAt: incident.begin,
      updatedAt: incident.modified,
      // Resolved against the root rather than concatenated: the feed's
      // "incidents/<id>" form has no leading slash, and concatenation
      // produced "https://status.cloud.google.comincidents/<id>".
      url: incident.uri ? new URL(incident.uri, `${sourceRoot.replace(/\/$/, "")}/`).href : sourceRoot,
    };
  });
  return { health, incidents: mapped, components };
}

function fromStatuspage(
  id: ServiceId,
  data: StatuspageSummary,
  latencyMs: number,
  componentFilter?: (name: string, group?: boolean) => boolean,
): ServiceSnapshot {
  const checkedAt = new Date().toISOString();
  const components = (data.components ?? [])
    .filter((component) => (componentFilter ? componentFilter(component.name, component.group) : !component.group))
    .map((component) => ({
      name: component.name,
      health: statuspageComponent(component.status),
    }));

  // Do not truncate here: the card below ranks non-operational components
  // first and then caps the list. Slicing to 8 up front dropped a broken
  // component that sorted past index 8 on a vendor with many components.
  let health = componentFilter
    ? components.reduce((acc, component) => worseHealth(acc, component.health), "operational" as Health)
    : statuspageIndicator(data.status?.indicator);

  if (componentFilter && components.length === 0) {
    health = statuspageIndicator(data.status?.indicator);
  }

  const activeIncidents = (data.incidents ?? []).filter((incident) => {
    const status = incident.status.toLowerCase();
    return status !== "resolved" && status !== "postmortem" && status !== "completed";
  });

  const incidents: Incident[] = activeIncidents
    .filter((incident) => {
      if (!componentFilter) return true;
      return componentFilter(incident.name, false);
    })
    .map((incident) => ({
      id: incident.id,
      title: incident.name,
      health: statuspageIndicator(incident.impact),
      startedAt: incident.started_at,
      updatedAt: incident.updated_at,
      url: incident.shortlink,
    }));

  const maintenances = (data.scheduled_maintenances ?? []).filter((item) => {
    const status = item.status.toLowerCase();
    return status === "in_progress" || status === "verifying";
  });

  if (maintenances.length && health === "operational") health = "maintenance";

  // During maintenance with no incident, the maintenance itself is what the
  // card should name; the indicator description is only a generic fallback.
  const hint =
    incidents[0]?.title ||
    (health === "maintenance" ? maintenances[0]?.name : undefined) ||
    data.status?.description;
  return {
    ...base(id, checkedAt, latencyMs),
    health,
    summary: overallSummary(health, incidents.length, hint),
    components: components.filter((component) => component.health !== "operational").concat(
      components.filter((component) => component.health === "operational").slice(0, 4),
    ).slice(0, 8),
    incidents,
  };
}

async function collectGcp(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() =>
      fetchJson<GoogleIncident[]>("https://status.cloud.google.com/incidents.json"),
    );
    const parsed = googleIncidents(value, "https://status.cloud.google.com");
    return {
      ...base("gcp", new Date().toISOString(), ms),
      health: parsed.health,
      summary: overallSummary(parsed.health, parsed.incidents.length, parsed.incidents[0]?.title),
      components: parsed.components.slice(0, 8),
      incidents: parsed.incidents,
    };
  } catch (error) {
    return failed("gcp", started, error);
  }
}

// `includes("resolved")` also matched "unresolved" and "not yet resolved",
// which would read a live incident's own update as its resolution.
export function saysResolved(text: string): boolean {
  const t = text.toLowerCase();
  return /\bresolved\b/.test(t) && !/\bnot\s+(?:yet\s+)?(?:been\s+)?resolved\b/.test(t);
}

export function awsEventActive(event: AwsEvent, now: number): boolean {
  if (event.end_time) return false;
  const summary = event.summary ?? "";
  if (/^\[resolved\]/i.test(summary)) return false;
  const last = event.event_log?.at(-1);
  const lastTs = (last?.timestamp ?? Number(event.date ?? 0)) * 1000;
  if (!lastTs || now - lastTs > STALE_MS) return false;
  const lastMessage = `${last?.summary ?? ""} ${last?.message ?? ""}`.toLowerCase();
  // `Number(undefined)` is NaN and `NaN !== 0` is true, so an event missing
  // `status` used to count as active. Fall back to the update text instead.
  // null and "" coerce to 0, which would read as resolved, so only a real
  // number or a non-blank numeric string counts as a reported status.
  const raw = event.status as unknown;
  const status =
    typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "")
      ? Number(raw)
      : Number.NaN;
  if (!Number.isFinite(status)) return !saysResolved(lastMessage);
  if (saysResolved(lastMessage) && status === 0) return false;
  return status !== 0;
}

function awsHealthFromEvent(event: AwsEvent): Health {
  const text = `${event.summary ?? ""} ${event.event_log?.at(-1)?.message ?? ""}`.toLowerCase();
  const region = (event.region_name ?? "").trim();
  if (text.includes("maintenance")) return "maintenance";
  // Regional Health items (one AZ / one region) are impact, not a global outage.
  if (region || /region availability/.test(text) || /availability zone/.test(text)) {
    return "degraded";
  }
  if (text.includes("outage") || text.includes("unavailable")) return "outage";
  return "degraded";
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
    const incidents: Incident[] = active.map((event) => {
      const itemHealth = awsHealthFromEvent(event);
      health = worseHealth(health, itemHealth);
      const last = event.event_log?.at(-1);
      return {
        id: event.arn ?? event.summary ?? crypto.randomUUID(),
        title: `${event.service_name ?? event.service ?? "AWS"} — ${event.summary ?? last?.summary ?? "Event"}`,
        health: itemHealth,
        startedAt: event.date ? new Date(Number(event.date) * 1000).toISOString() : undefined,
        updatedAt: last?.timestamp ? new Date(last.timestamp * 1000).toISOString() : undefined,
        url: "https://health.aws.amazon.com/health/status",
      };
    });
    return {
      ...base("aws", new Date().toISOString(), ms),
      health,
      summary: overallSummary(
        health,
        incidents.length,
        incidents[0]?.title ?? `${value.length} public Health items, none currently active.`,
      ),
      components: active.slice(0, 8).map((event) => ({
        name: `${event.service_name ?? "Service"} (${event.region_name ?? "global"})`,
        health: awsHealthFromEvent(event),
        detail: event.summary,
      })),
      incidents,
      meta: { publicEvents: value.length, active: active.length },
    };
  } catch (error) {
    return failed("aws", started, error);
  }
}

async function collectSteam(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    // allSettled, not all: one endpoint being down should degrade the card,
    // not blank it. Only when neither answers usefully do we fail the whole
    // collector, and with the real error rather than a generic outage.
    const [info, store] = await Promise.allSettled([
      fetchJson<{ servertime?: unknown } | null>("https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/"),
      fetchJson<{ featured_win?: unknown } | null>("https://store.steampowered.com/api/featured/"),
    ]);
    const servertime = info.status === "fulfilled" ? info.value?.servertime : undefined;
    const apiOk = typeof servertime === "number";
    const storeOk = store.status === "fulfilled" && Array.isArray(store.value?.featured_win);
    if (!apiOk && !storeOk) {
      if (info.status === "rejected") throw info.reason;
      if (store.status === "rejected") throw store.reason;
      throw new PayloadError("Steam Web API and Store answered in an unexpected shape.");
    }
    // The half that failed says why on its component, so a Degraded card is
    // never left without a reason.
    const why = (result: PromiseSettledResult<unknown>) =>
      result.status === "rejected" ? classifyFailure(result.reason).message : "Unexpected response shape.";
    const health: Health = apiOk && storeOk ? "operational" : "degraded";
    const components: ComponentHealth[] = [
      apiOk ? { name: "Steam Web API", health: "operational" } : { name: "Steam Web API", health: "outage", detail: why(info) },
      storeOk ? { name: "Steam Store", health: "operational" } : { name: "Steam Store", health: "outage", detail: why(store) },
    ];
    return {
      ...base("steam", new Date().toISOString(), Date.now() - started),
      health,
      summary: overallSummary(health, 0, health === "operational" ? "Web API and Store responding." : undefined),
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

async function collectEpic(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() =>
      fetchJson<StatuspageSummary>("https://status.epicgames.com/api/v2/summary.json"),
    );
    return fromStatuspage("epic", value, ms, (name) => !/fortnite/i.test(name));
  } catch (error) {
    return failed("epic", started, error);
  }
}

async function collectFortnite(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() =>
      fetchJson<StatuspageSummary>("https://status.epicgames.com/api/v2/summary.json"),
    );
    return fromStatuspage("fortnite", value, ms, (name) => /fortnite/i.test(name));
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

function appleEventHealth(event: {
  eventStatus?: string;
  statusType?: string;
}): Health {
  const status = (event.eventStatus ?? "").toLowerCase();
  const type = (event.statusType ?? "").toLowerCase();
  if (status === "resolved" || status === "completed") return "operational";
  if (status !== "ongoing" && status !== "current" && status !== "upcoming") return "operational";
  if (type === "outage") return "outage";
  if (type === "maintenance") return "maintenance";
  return "degraded";
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
    for (const service of value.services ?? []) {
      const active = (service.events ?? []).filter((event) => {
        const itemHealth = appleEventHealth(event);
        return itemHealth !== "operational";
      });
      if (!active.length) continue;
      for (const event of active) {
        const itemHealth = appleEventHealth(event);
        health = worseHealth(health, itemHealth);
        components.push({ name: service.serviceName, health: itemHealth, detail: event.message });
        incidents.push({
          id: `${service.serviceName}-${event.epochStartDate ?? event.datePosted ?? event.message}`,
          title: `${service.serviceName}: ${event.message ?? event.statusType ?? "Issue"}`,
          health: itemHealth,
          startedAt: event.epochStartDate ? new Date(event.epochStartDate).toISOString() : undefined,
          url: "https://www.apple.com/support/systemstatus/",
        });
      }
    }
    return {
      ...base("apple", new Date().toISOString(), ms),
      health,
      summary: overallSummary(health, incidents.length, incidents[0]?.title),
      components: components.slice(0, 10),
      incidents,
      meta: { services: value.services?.length ?? 0 },
    };
  } catch (error) {
    return failed("apple", started, error);
  }
}

async function collectAndroid(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() =>
      fetchJson<GoogleIncident[]>("https://status.play.google.com/incidents.json"),
    );
    const parsed = googleIncidents(value, "https://status.play.google.com");
    return {
      ...base("android", new Date().toISOString(), ms),
      health: parsed.health,
      summary: overallSummary(parsed.health, parsed.incidents.length, parsed.incidents[0]?.title),
      components: parsed.components.slice(0, 8),
      incidents: parsed.incidents,
    };
  } catch (error) {
    return failed("android", started, error);
  }
}

// Only strip comments and things that look like tags (`<` or `</` followed by
// a letter). A blanket `<[^>]+>` also ate a decoded "Latency < 500ms", which
// erased "Status: Resolved" from an otherwise operational item. Plain text
// such as "a<b ... c>d" still reads as a tag; regex stripping cannot tell.
function stripHtml(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^<>]*>/g, " ")
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
// and decode only the parts outside them.
const CDATA_RE = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

const CDATA_START = "<![CDATA[";

export function decodeXmlField(raw: string): string {
  let result = "";
  let lastIndex = 0;
  CDATA_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CDATA_RE.exec(raw))) {
    result += decodeXmlEntities(raw.slice(lastIndex, match.index));
    result += match[1];
    lastIndex = CDATA_RE.lastIndex;
  }
  // Any `<![CDATA[` left in the tail has no closing `]]>` anywhere later in
  // the string, or the loop above would already have consumed it. Treat
  // everything from that marker onward as literal CDATA content: strip the
  // marker and leave the rest undecoded, rather than decoding text the feed
  // meant to be taken as-is.
  const tail = raw.slice(lastIndex);
  const unterminated = tail.indexOf(CDATA_START);
  if (unterminated === -1) {
    result += decodeXmlEntities(tail);
  } else {
    result += decodeXmlEntities(tail.slice(0, unterminated));
    result += tail.slice(unterminated + CDATA_START.length);
  }
  return result;
}

export function parseRssItems(xml: string): Array<{ title: string; description: string; pubDate?: string; link?: string }> {
  const items: Array<{ title: string; description: string; pubDate?: string; link?: string }> = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks) {
    const chunk = block.split(/<\/item>/i)[0] ?? "";
    const title = decodeXmlField(chunk.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
    const description = decodeXmlField(chunk.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? "").trim();
    const pubDate = chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim();
    const rawLink = chunk.match(/<link>([\s\S]*?)<\/link>/i)?.[1];
    const link = rawLink !== undefined ? decodeXmlField(rawLink).trim() : undefined;
    items.push({ title, description, pubDate, link });
  }
  return items;
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
export function grokItemActive(
  item: { description: string; pubDate?: string },
  now: number,
): boolean {
  if (grokItemHealth(item.description) === "operational") return false;
  const at = item.pubDate ? Date.parse(item.pubDate) : Number.NaN;
  return Number.isFinite(at) && now - at <= STALE_MS;
}

async function collectGrok(): Promise<ServiceSnapshot> {
  const started = Date.now();
  try {
    const { value, ms } = await timed(() => fetchText("https://status.x.ai/feed.xml"));
    const items = parseRssItems(value.body);
    // parseRssItems only understands RSS 2.0 <item>. If x.ai moves to Atom
    // the parse yields nothing, and reporting that as "operational" would be
    // a confident all-clear built on no data. Unknown is the honest answer.
    if (items.length === 0) throw new PayloadError("Grok feed returned no readable items.");
    const now = Date.now();
    const active = items.filter((item) => grokItemActive(item, now));
    let health: Health = "operational";
    const incidents: Incident[] = active.slice(0, 8).map((item, index) => {
      const itemHealth = grokItemHealth(item.description);
      health = worseHealth(health, itemHealth);
      return {
        id: item.link ?? `${item.title}-${index}`,
        title: item.title,
        health: itemHealth,
        startedAt: item.pubDate ? new Date(item.pubDate).toISOString() : undefined,
        url: item.link ?? "https://status.x.ai/",
      };
    });
    return {
      ...base("grok", new Date().toISOString(), ms),
      health,
      summary: overallSummary(health, incidents.length, incidents[0]?.title),
      components: [],
      incidents,
    };
  } catch (error) {
    return failed("grok", started, error);
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
        if (unparsed > 0) throw new PayloadError(`MikroTik answered ${unparsed} version channel(s) in an unrecognised format.`);
        throw new SourceError("MikroTik version channels did not respond.");
      }
      const stable = channels.find((channel) => channel.file === "NEWESTa7.stable");
      const newest = channels.reduce((current, channel) => {
        const currentTime = Date.parse(current.releasedAt ?? "") || 0;
        const nextTime = Date.parse(channel.releasedAt ?? "") || 0;
        return nextTime > currentTime ? channel : current;
      }, channels[0]);
      let notes = "";
      const notesVersion = newest?.version ?? stable?.version;
      if (notesVersion) {
        try {
          const changelog = await fetchText(`https://download.mikrotik.com/routeros/${notesVersion}/CHANGELOG`);
          notes = summarizeMikrotikChangelog(changelog.body);
        } catch {
          notes = "";
        }
      }
      return { channels, notes, stable, newest };
    });

    const components: ComponentHealth[] = value.channels.map((channel) => ({
      name: channel.name,
      health: isFreshRelease(channel.releasedAt) ? "maintenance" : "operational",
      detail: [channel.version, formatReleaseAge(channel.releasedAt)].filter(Boolean).join(" · "),
    }));

    const latest = value.stable?.version ?? value.newest?.version ?? value.channels[0]?.version ?? "";
    const latestDate = formatReleaseAge(value.newest?.releasedAt ?? value.stable?.releasedAt);
    const summary =
      value.notes ||
      (latest ? `Latest RouterOS ${latest}${latestDate ? ` · ${latestDate}` : ""}` : "RouterOS channels loaded.");

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

    const components: ComponentHealth[] = latest.map((release) => ({
      name: release.family,
      health: isFreshRelease(release.publishedAt) ? "maintenance" : "operational",
      detail: [release.version, formatReleaseAge(release.publishedAt)].filter(Boolean).join(" · "),
    }));

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

// Runs one collector with its own byte meter, and logs the success line
// that pairs with failed()'s collector_failed, so the log shows every
// source's latency and download size per sweep, not only the broken ones.
function metered(collect: () => Promise<ServiceSnapshot>): Promise<ServiceSnapshot> {
  return meterBytes(async (meter) => {
    const snapshot = await collect();
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
  return Promise.all(
    [
      collectGcp,
      collectAws,
      collectSteam,
      collectCs2Europe,
      collectEpic,
      collectFortnite,
      collectSpotify,
      collectApple,
      collectAndroid,
      collectGrok,
      collectChatGpt,
      collectClaude,
      collectMikrotik,
      collectAppleOs,
    ].map(metered),
  );
}
