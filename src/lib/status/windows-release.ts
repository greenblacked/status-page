import { clip } from "./bounds.ts";

/**
 * The Windows 11 versions Microsoft lists on its release health page
 * (https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information).
 * That page is the one official place that names every version with its
 * availability date and build, and a version Microsoft adds (26H2, then the
 * next one) shows up there as a new row, so nothing here lists versions. It is
 * HTML with no feed or API behind it; CONTRIBUTING.md records the exception.
 *
 * The page is vendor input of up to 4 MiB, so everything below is a single
 * linear scan with a ceiling on tables, rows, cells and text, never a regex
 * that can backtrack against itself.
 */
export type WindowsRelease = {
  /** "26H2": the feature update's name. */
  version: string;
  /** When the version became available, as ISO 8601 (a day, at 00:00 UTC). */
  availableAt: string;
  /** The date of its latest cumulative update, when the table gives one. */
  updatedAt?: string;
  /** Latest build, "26300.1234", when the table gives one. */
  build?: string;
};

export const WINDOWS_NAME = "Windows 11";

const MAX_TABLES = 40;
const MAX_ROWS = 120;
const MAX_CELLS = 16;
const MAX_CELL_CHARS = 200;
/** Newest versions kept: the ones still in service, not the page's whole history. */
const MAX_VERSIONS = 4;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// One alternation of bounded pieces, so it cannot backtrack.
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (match, body: string) => {
    if (body[0] !== "#") return ENTITIES[body.toLowerCase()] ?? match;
    const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function tidy(text: string): string {
  return clip(decodeEntities(text).replace(/\s+/g, " ").trim(), MAX_CELL_CHARS);
}

const SPACING_TAGS = new Set(["br", "p", "div", "li", "ul", "ol"]);

/**
 * Every top-level `<table>` of an HTML page as rows of cell text, cut at
 * MAX_TABLES, MAX_ROWS, MAX_CELLS and MAX_CELL_CHARS. Not an HTML parser: it
 * knows `table`, `tr`, `td` and `th`, skips comments, `script` and `style`,
 * and ignores a table nested inside another. Each tag is found with one
 * `indexOf("<")` and one `indexOf(">")` from where the last ended, so the
 * whole page is read once; markup that never closes simply ends the scan.
 */
export function readHtmlTables(html: string): string[][][] {
  const tables: string[][][] = [];
  let table: string[][] | null = null;
  let row: string[] | null = null;
  let cell: string | null = null;
  let depth = 0;
  let pos = 0;

  const endCell = () => {
    if (cell !== null && row !== null && row.length < MAX_CELLS) row.push(tidy(cell));
    cell = null;
  };
  const endRow = () => {
    endCell();
    if (row !== null && row.length > 0 && table !== null && table.length < MAX_ROWS) table.push(row);
    row = null;
  };

  while (pos < html.length) {
    const lt = html.indexOf("<", pos);
    const textEnd = lt === -1 ? html.length : lt;
    // Text is gathered only inside a cell, and only up to a few cells' worth.
    if (cell !== null && depth === 1 && cell.length < MAX_CELL_CHARS * 4) {
      cell += html.slice(pos, Math.min(textEnd, pos + MAX_CELL_CHARS * 4));
    }
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) break;
      pos = end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    pos = gt + 1;

    const closing = html[lt + 1] === "/";
    let nameEnd = lt + (closing ? 2 : 1);
    while (nameEnd < gt && nameEnd - lt < 12 && /[A-Za-z0-9]/.test(html[nameEnd])) nameEnd += 1;
    const name = html.slice(lt + (closing ? 2 : 1), nameEnd).toLowerCase();

    if (!closing && (name === "script" || name === "style")) {
      const end = html.indexOf(`</${name}`, pos);
      if (end === -1) break;
      pos = end;
      continue;
    }
    if (name === "table") {
      if (!closing) {
        depth += 1;
        if (depth === 1) {
          if (tables.length >= MAX_TABLES) break;
          table = [];
        }
      } else if (depth > 0) {
        depth -= 1;
        if (depth === 0) {
          endRow();
          if (table !== null) tables.push(table);
          table = null;
        }
      }
    } else if (depth === 1) {
      if (name === "tr") {
        endRow();
        if (!closing) row = [];
      } else if (name === "td" || name === "th") {
        endCell();
        if (!closing) {
          row ??= [];
          cell = "";
        }
      } else if (cell !== null && SPACING_TAGS.has(name)) {
        cell += " ";
      }
    }
  }
  endRow();
  if (table !== null && table.length > 0 && tables.length < MAX_TABLES) tables.push(table);
  return tables;
}

type Columns = { version: number; available: number; updated: number; build: number };

// The table of versions has "Version" and "Availability date" columns; the
// per-version update history tables below it name neither, so they are never
// taken for it. Header names are matched by what they contain, because
// Microsoft has reworded them ("Latest build", "OS build") before.
function findColumns(header: string[]): Columns | null {
  const lower = header.map((cell) => cell.toLowerCase());
  const find = (test: (cell: string) => boolean) => lower.findIndex(test);
  const columns: Columns = {
    version: find((cell) => cell === "version" || cell.startsWith("version ")),
    available: find((cell) => cell.includes("availability")),
    updated: find((cell) => cell.includes("revision")),
    build: find((cell) => cell.includes("build")),
  };
  return columns.version >= 0 && columns.available >= 0 ? columns : null;
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

/** "26H2" out of "26H2", "Version 26H2" or "Windows 11, version 26H2 (OS build 26300)", else null. */
export function parseWindowsVersion(text: string): string | null {
  for (let at = text.indexOf("H"); at !== -1; at = text.indexOf("H", at + 1)) {
    const half = text[at + 1];
    if (at < 2 || (half !== "1" && half !== "2")) continue;
    if (!isDigit(text[at - 1]) || !isDigit(text[at - 2]) || isDigit(text[at - 3]) || isDigit(text[at + 2])) continue;
    if (/[A-Za-z]/.test(text[at - 3] ?? "") || /[A-Za-z]/.test(text[at + 2] ?? "")) continue;
    return text.slice(at - 2, at + 2);
  }
  return null;
}

/** An ISO 8601 day ("2026-09-29") found in a cell, as a UTC timestamp string, else undefined. */
export function parseWindowsDate(text: string): string | undefined {
  for (let at = text.indexOf("-"); at !== -1; at = text.indexOf("-", at + 1)) {
    const day = text.slice(at - 4, at + 6);
    if (at < 4 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const time = Date.parse(`${day}T00:00:00.000Z`);
    if (Number.isFinite(time) && new Date(time).toISOString().startsWith(day)) return new Date(time).toISOString();
  }
  return undefined;
}

/** A build such as "26300.1234" found in a cell, else undefined. */
export function parseWindowsBuild(text: string): string | undefined {
  const match = text.match(/(?:^|[^\d.])(\d{5}\.\d{1,6})(?![\d.])/);
  return match?.[1];
}

/**
 * The newest Windows 11 versions out of every table on the page, newest
 * first by availability date. Rows that do not read as a version and a date
 * (a footnote, a blank line) are skipped; an empty list means the page no
 * longer has the table, which is the collector's cue to read as unknown.
 */
export function windowsReleases(tables: string[][][]): WindowsRelease[] {
  for (const table of tables) {
    const headerAt = table.slice(0, 3).findIndex((row) => findColumns(row) !== null);
    if (headerAt === -1) continue;
    const columns = findColumns(table[headerAt]);
    if (!columns) continue;
    const seen = new Set<string>();
    const releases: WindowsRelease[] = [];
    for (const row of table.slice(headerAt + 1)) {
      const version = parseWindowsVersion(row[columns.version] ?? "");
      const availableAt = parseWindowsDate(row[columns.available] ?? "");
      if (!version || !availableAt || seen.has(version)) continue;
      seen.add(version);
      releases.push({
        version,
        availableAt,
        updatedAt: columns.updated >= 0 ? parseWindowsDate(row[columns.updated] ?? "") : undefined,
        build: columns.build >= 0 ? parseWindowsBuild(row[columns.build] ?? "") : undefined,
      });
    }
    if (releases.length > 0) {
      return releases
        .sort((a, b) =>
          a.availableAt === b.availableAt ? (a.version < b.version ? 1 : -1) : a.availableAt < b.availableAt ? 1 : -1,
        )
        .slice(0, MAX_VERSIONS);
    }
  }
  return [];
}

/** When a version last shipped something: its latest update, or else its first availability. */
export function windowsShippedAt(release: WindowsRelease): string {
  return release.updatedAt && release.updatedAt > release.availableAt ? release.updatedAt : release.availableAt;
}
