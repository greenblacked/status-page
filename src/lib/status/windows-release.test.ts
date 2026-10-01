import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseWindowsBuild,
  parseWindowsDate,
  parseWindowsVersion,
  readHtmlTables,
  windowsReleases,
  windowsShippedAt,
} from "./windows-release.ts";

const page = readFileSync(
  new URL("./__fixtures__/windows/windows11-release-information.html", import.meta.url),
  "utf8",
);

const versionsTable = (rows: string[], header = "Version|Availability date|Latest build") =>
  `<table><tr>${header
    .split("|")
    .map((cell) => `<th>${cell}</th>`)
    .join("")}</tr>${rows
    .map(
      (row) =>
        `<tr>${row
          .split("|")
          .map((cell) => `<td>${cell}</td>`)
          .join("")}</tr>`,
    )
    .join("")}</table>`;

describe("readHtmlTables", () => {
  it("reads every top-level table as rows of cell text, skipping script, style and comments", () => {
    const tables = readHtmlTables(page);
    expect(tables).toHaveLength(2);
    expect(tables[0][0].slice(0, 5)).toEqual([
      "Version",
      "Servicing option",
      "Availability date",
      "Latest revision date",
      "Latest build",
    ]);
    expect(tables[0][1].slice(0, 5)).toEqual([
      "26H2",
      "General Availability Channel",
      "2026-09-29",
      "2026-09-29",
      "26300.1000",
    ]);
    expect(JSON.stringify(tables)).not.toContain("99H9");
    expect(JSON.stringify(tables)).not.toContain("98H8");
  });

  it("decodes entities, collapses whitespace and puts a space where a line breaks", () => {
    const [table] = readHtmlTables("<table><tr><td> a&nbsp;&amp;\n b<br>c&#65;&#x42;&bogus; </td></tr></table>");
    expect(table).toEqual([["a & b cAB&bogus;"]]);
  });

  it("ignores a table nested in a cell and tags in any case", () => {
    const [table] = readHtmlTables("<TABLE><TR><TD>outer<table><tr><td>inner</td></tr></table></TD></TR></TABLE>");
    expect(table).toEqual([["outer"]]);
  });

  it("keeps what it read of a table that never closes, and nothing of a tag that never ends", () => {
    expect(readHtmlTables("<table><tr><td>a</td><td>b")).toEqual([[["a", "b"]]]);
    expect(readHtmlTables("<table><tr><td>a</td></tr></table><table <tr")).toEqual([[["a"]]]);
    expect(readHtmlTables("<table><!-- never closed <tr><td>a</td></tr></table>")).toEqual([]);
    expect(readHtmlTables("<script>never closed <table><tr><td>a</td></tr></table>")).toEqual([]);
  });

  it("bounds tables, rows, cells and cell text", () => {
    const wide = `<table><tr>${"<td>x</td>".repeat(100)}</tr></table>`;
    expect(readHtmlTables(wide)[0][0]).toHaveLength(16);
    const tall = `<table>${"<tr><td>x</td></tr>".repeat(500)}</table>`;
    expect(readHtmlTables(tall)[0]).toHaveLength(120);
    const many = "<table><tr><td>x</td></tr></table>".repeat(500);
    expect(readHtmlTables(many)).toHaveLength(40);
    const [[[long]]] = readHtmlTables(`<table><tr><td>${"y".repeat(100_000)}</td></tr></table>`);
    expect(long).toHaveLength(200);
  });
});

describe("parseWindowsVersion", () => {
  it.each([
    ["26H2", "26H2"],
    ["Version 25H2", "25H2"],
    ["Windows 11, version 26H1 (OS build 28000)", "26H1"],
    ["27H2 (Experimental)", "27H2"],
  ])("reads %s", (text, version) => expect(parseWindowsVersion(text)).toBe(version));

  it.each(["", "Version", "26H3", "126H2", "A26H2", "26H20", "H2", "5H2", "2H1 2H2"])("refuses %j", (text) =>
    expect(parseWindowsVersion(text)).toBeNull(),
  );
});

describe("parseWindowsDate and parseWindowsBuild", () => {
  it("reads an ISO day and nothing that is not a real date", () => {
    expect(parseWindowsDate("2026-09-29")).toBe("2026-09-29T00:00:00.000Z");
    expect(parseWindowsDate("Sep 29 (2026-09-29)")).toBe("2026-09-29T00:00:00.000Z");
    expect(parseWindowsDate("2026-02-30")).toBeUndefined();
    expect(parseWindowsDate("2026-13-01")).toBeUndefined();
    expect(parseWindowsDate("29/09/2026")).toBeUndefined();
    expect(parseWindowsDate("-2026-09-2")).toBeUndefined();
  });

  it("reads a five-digit build with a revision", () => {
    expect(parseWindowsBuild("26300.1000")).toBe("26300.1000");
    expect(parseWindowsBuild("OS build 26300.1000 (KB5000000)")).toBe("26300.1000");
    expect(parseWindowsBuild("26300")).toBeUndefined();
    expect(parseWindowsBuild("126300.1000")).toBeUndefined();
    expect(parseWindowsBuild("1.2.26300.1000")).toBeUndefined();
  });
});

describe("windowsReleases", () => {
  it("takes the versions table, not the update history under it, newest first, four of them", () => {
    expect(windowsReleases(readHtmlTables(page))).toEqual([
      {
        version: "26H2",
        availableAt: "2026-09-29T00:00:00.000Z",
        updatedAt: "2026-09-29T00:00:00.000Z",
        build: "26300.1000",
      },
      {
        version: "26H1",
        availableAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-09-22T00:00:00.000Z",
        build: "28000.1575",
      },
      {
        version: "25H2",
        availableAt: "2025-09-30T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:00.000Z",
        build: "26200.8100",
      },
      {
        version: "24H2",
        availableAt: "2024-10-01T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:00.000Z",
        build: "26100.8100",
      },
    ]);
  });

  it("picks up a version the page did not list before, wherever its row is", () => {
    const before = versionsTable(["26H2|2026-09-29|26300.1000", "25H2|2025-09-30|26200.8100"]);
    const after = versionsTable([
      "25H2|2025-09-30|26200.8100",
      "27H2|2027-09-28|27000.1",
      "26H2|2026-09-29|26300.1000",
    ]);
    expect(windowsReleases(readHtmlTables(before)).map((release) => release.version)).toEqual(["26H2", "25H2"]);
    expect(windowsReleases(readHtmlTables(after)).map((release) => release.version)).toEqual(["27H2", "26H2", "25H2"]);
  });

  it("reads columns by name, whatever their order, and works without the optional ones", () => {
    const table = versionsTable(["2026-09-29|26H2"], "Availability date|Version");
    expect(windowsReleases(readHtmlTables(table))).toEqual([
      { version: "26H2", availableAt: "2026-09-29T00:00:00.000Z", updatedAt: undefined, build: undefined },
    ]);
  });

  it("skips rows without a version or a date and repeats of a version", () => {
    const table = versionsTable([
      "Note|2026-09-29|",
      "26H2|soon|",
      "26H2|2026-09-29|26300.1",
      "26H2|2026-01-01|26300.0",
    ]);
    expect(windowsReleases(readHtmlTables(table)).map((release) => release.availableAt)).toEqual([
      "2026-09-29T00:00:00.000Z",
    ]);
  });

  it("is empty when no table has a Version and an Availability date column, or no row reads", () => {
    expect(windowsReleases([])).toEqual([]);
    expect(windowsReleases(readHtmlTables(versionsTable(["26H2|2026-09-29"], "Name|Date")))).toEqual([]);
    expect(windowsReleases(readHtmlTables(versionsTable(["soon|later"])))).toEqual([]);
    expect(windowsReleases(readHtmlTables("<html><body>We'll be back soon.</body></html>"))).toEqual([]);
  });

  it("names 26H2-style versions by their half", () => {
    const [release] = windowsReleases(readHtmlTables(versionsTable(["26H2|2026-09-29|26300.1000"])));
    expect(release.version).toBe("26H2");
  });
});

describe("windowsShippedAt", () => {
  it("is the later of the first availability and the latest update", () => {
    const base = { version: "26H1", availableAt: "2026-02-10T00:00:00.000Z" };
    expect(windowsShippedAt(base)).toBe(base.availableAt);
    expect(windowsShippedAt({ ...base, updatedAt: "2026-09-22T00:00:00.000Z" })).toBe("2026-09-22T00:00:00.000Z");
    expect(windowsShippedAt({ ...base, updatedAt: "2026-01-01T00:00:00.000Z" })).toBe(base.availableAt);
  });
});
