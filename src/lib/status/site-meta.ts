import { APP_NAME, CATALOG, SITE_ORIGIN } from "./catalog.ts";
import { countWord } from "./verdict.ts";

/** The five services the description names; the count of the rest is spelled out from the catalog. */
const NAMED = ["Google Cloud", "AWS", "Steam", "ChatGPT", "Claude"];

/**
 * The description search results and link previews show. In the owner's voice,
 * not a list of every name: "and nine more" is counted from the catalog, so
 * adding a service cannot leave it wrong.
 */
export const SITE_DESCRIPTION = `Is it them or is it me? ${NAMED.join(", ")} and ${countWord(CATALOG.length - NAMED.length)} more, read from their own status pages.`;

/** The preview image (public/og.jpg, drawn from docs/og-image.html): an absolute URL, which scrapers need. */
export const OG_IMAGE = {
  url: `${SITE_ORIGIN}/og.jpg`,
  width: 1200,
  height: 630,
  alt: `${APP_NAME}: is it them or is it me?`,
} as const;

/** Where the page lives, for og:url and the canonical link. */
export const CANONICAL_URL = `${SITE_ORIGIN}/`;
