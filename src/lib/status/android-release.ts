/**
 * The Android versions Google lists on its releases page
 * (https://developer.android.com/about/versions). The page is the one official
 * place that names every Android version, and a version Google adds (Android
 * 18, then the next one) shows up in its release menu and footer as a new link,
 * so nothing here lists versions. It is HTML with no feed or API behind it;
 * CONTRIBUTING.md records the exception.
 *
 * The page gives no release dates, and the cards of its body lag behind its
 * menu, so the reading is of the links `/about/versions/<number>` whose text
 * is "Android <number>": the release menu and the footer carry them, newest
 * first. It lists major versions only. The quarterly platform releases (QPRs)
 * have pages of their own that describe betas, with no stable release listed
 * anywhere on this page, so none is read as a release.
 *
 * The page is vendor input of up to 4 MiB, so everything below is a single
 * linear scan with a ceiling on links, tag length and text, never a regex that
 * can backtrack against itself.
 */
export type AndroidRelease = {
  /** "17": the version number as the page links it. */
  version: string;
  /** "Android 17": the version with the OS name, what the card shows. */
  name: string;
};

export const ANDROID_NAME = "Android";

/** The releases page, the one place the versions are read from. */
export const ANDROID_VERSIONS_URL = "https://developer.android.com/about/versions";

/** Newest versions kept: the ones in service, not the page's whole history. */
const MAX_RELEASES = 4;
/** Most `<a>` tags looked at in one page; the real page has a few hundred. */
export const MAX_ANDROID_LINKS = 20_000;
/** An opening tag longer than this is not a version link. */
const MAX_TAG_CHARS = 2_000;
/** A link's markup between its tags longer than this is not a bare "Android 17". */
const MAX_LINK_CHARS = 400;

const HREF_PATHS = ["/about/versions/", "https://developer.android.com/about/versions/"];

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r" || char === "\f";
}

// The version number out of an opening tag's attributes when its href is
// `/about/versions/<one or two digits>` (the page's own path or the full URL,
// with an optional trailing slash, query or fragment), else "".
function versionFromAttributes(attributes: string): string {
  let at = attributes.indexOf("href=");
  if (at === -1) return "";
  at += 5;
  const quote = attributes[at];
  if (quote !== '"' && quote !== "'") return "";
  const end = attributes.indexOf(quote, at + 1);
  if (end === -1) return "";
  const href = attributes.slice(at + 1, end);
  const prefix = HREF_PATHS.find((path) => href.startsWith(path));
  if (!prefix) return "";
  let digits = prefix.length;
  while (isDigit(href[digits])) digits += 1;
  const version = href.slice(prefix.length, digits);
  const rest = href.slice(digits);
  if (version.length === 0 || version.length > 2) return "";
  return rest === "" || rest === "/" || rest[0] === "?" || rest[0] === "#" ? version : "";
}

// The text of a piece of markup: tags dropped, runs of white space made one space.
function textOf(markup: string): string {
  let text = "";
  let inTag = false;
  let space = false;
  for (const char of markup) {
    if (char === "<") inTag = true;
    else if (char === ">") inTag = false;
    else if (!inTag) {
      if (isSpace(char)) space = text.length > 0;
      else {
        if (space) text += " ";
        space = false;
        text += char;
      }
    }
  }
  return text;
}

/**
 * The version numbers ("17", "16", ...) the page links as "Android <number>",
 * in the order the page gives them, each once. Not an HTML parser: it knows
 * `<a href>` and the text up to the next `</a>`. Each tag is found with one
 * `indexOf("<a")` and one `indexOf(">")` from where the last ended, and each
 * closing tag is searched from where the last one was found, so the whole page
 * is read once; markup that never closes simply ends the scan.
 */
export function readAndroidVersionLinks(html: string): string[] {
  const versions = new Set<string>();
  let pos = 0;
  let closeAt = -1;
  for (let links = 0; links < MAX_ANDROID_LINKS; links += 1) {
    const open = html.indexOf("<a", pos);
    if (open === -1) break;
    if (!isSpace(html[open + 2])) {
      pos = open + 2;
      continue;
    }
    const gt = html.indexOf(">", open + 2);
    if (gt === -1) break;
    pos = gt + 1;
    if (gt - open > MAX_TAG_CHARS) continue;
    const version = versionFromAttributes(html.slice(open + 2, gt));
    if (!version) continue;
    if (closeAt < pos) {
      closeAt = html.indexOf("</a>", pos);
      if (closeAt === -1) break;
    }
    if (closeAt - pos > MAX_LINK_CHARS) continue;
    if (textOf(html.slice(pos, closeAt)) === `${ANDROID_NAME} ${version}`) versions.add(version);
  }
  return [...versions];
}

/**
 * The newest Android versions among the numbers a page links, newest first,
 * at most MAX_RELEASES. An empty list means the page no longer lists any,
 * which is the collector's cue to read as unknown.
 */
export function androidReleases(versions: string[]): AndroidRelease[] {
  return [...new Set(versions)]
    .sort((a, b) => Number(b) - Number(a))
    .slice(0, MAX_RELEASES)
    .map((version) => ({ version, name: `${ANDROID_NAME} ${version}` }));
}
