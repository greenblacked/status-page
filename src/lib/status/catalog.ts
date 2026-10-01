import type { CategoryId, ServiceId } from "./types.ts";

export const APP_NAME = "Status";

/** The deployed origin, for the absolute URLs a link preview needs (og:url, og:image, the canonical link). */
export const SITE_ORIGIN = "https://status.szolotov.com";

export type CatalogEntry = {
  id: ServiceId;
  name: string;
  shortName: string;
  category: CategoryId;
  sourceName: string;
  sourceUrl: string;
};

export const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: "cloud", label: "Cloud" },
  { id: "gaming", label: "Gaming" },
  { id: "platforms", label: "Platforms" },
  { id: "ai", label: "AI" },
  { id: "updates", label: "Releases" },
];

export const CATALOG: CatalogEntry[] = [
  {
    id: "gcp",
    name: "Google Cloud",
    shortName: "GCP",
    category: "cloud",
    sourceName: "Google Cloud Service Health",
    sourceUrl: "https://status.cloud.google.com/",
  },
  {
    id: "aws",
    name: "Amazon Web Services",
    shortName: "AWS",
    category: "cloud",
    sourceName: "AWS Health Dashboard",
    sourceUrl: "https://health.aws.amazon.com/health/status",
  },
  {
    id: "steam",
    name: "Steam",
    shortName: "Steam",
    category: "gaming",
    sourceName: "Steam Web API",
    sourceUrl: "https://store.steampowered.com/",
  },
  {
    id: "cs2-europe",
    name: "CS2 Europe",
    shortName: "CS2 EU",
    category: "gaming",
    sourceName: "Valve relay list",
    sourceUrl: "https://store.steampowered.com/app/730/",
  },
  {
    id: "epic",
    name: "Epic Games",
    shortName: "Epic",
    category: "gaming",
    sourceName: "Epic Games Status",
    sourceUrl: "https://status.epicgames.com/",
  },
  {
    id: "fortnite",
    name: "Fortnite",
    shortName: "Fortnite",
    category: "gaming",
    sourceName: "Epic Games Status",
    sourceUrl: "https://status.epicgames.com/",
  },
  {
    id: "spotify",
    name: "Spotify",
    shortName: "Spotify",
    category: "platforms",
    sourceName: "Spotify Status",
    sourceUrl: "https://spotify.statuspage.io/",
  },
  {
    id: "apple",
    name: "Apple",
    shortName: "Apple",
    category: "platforms",
    sourceName: "Apple System Status",
    sourceUrl: "https://www.apple.com/support/systemstatus/",
  },
  {
    id: "android",
    name: "Android / Play",
    shortName: "Android",
    category: "platforms",
    sourceName: "Google Play Status",
    sourceUrl: "https://status.play.google.com/summary",
  },
  {
    id: "grok",
    name: "Grok",
    shortName: "Grok",
    category: "ai",
    sourceName: "xAI System Status",
    sourceUrl: "https://status.x.ai/",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    shortName: "ChatGPT",
    category: "ai",
    sourceName: "OpenAI Status",
    sourceUrl: "https://status.openai.com/",
  },
  {
    id: "claude",
    name: "Claude",
    shortName: "Claude",
    category: "ai",
    sourceName: "Claude Status",
    sourceUrl: "https://status.claude.com/",
  },
  {
    id: "mikrotik",
    name: "MikroTik RouterOS",
    shortName: "RouterOS",
    category: "updates",
    sourceName: "MikroTik changelogs",
    sourceUrl: "https://mikrotik.com/download/changelogs",
  },
  {
    id: "apple-os",
    name: "Apple OS",
    shortName: "Apple OS",
    category: "updates",
    sourceName: "Apple Developer Releases",
    sourceUrl: "https://developer.apple.com/news/releases/",
  },
  {
    id: "windows",
    name: "Windows 11",
    shortName: "Windows 11",
    category: "updates",
    sourceName: "Windows release health",
    sourceUrl: "https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information",
  },
];

export const CATALOG_BY_ID = Object.fromEntries(CATALOG.map((entry) => [entry.id, entry])) as Record<
  ServiceId,
  CatalogEntry
>;
