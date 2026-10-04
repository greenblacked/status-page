import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseWindowsBuild,
  parseWindowsDate,
  parseWindowsKb,
  parseWindowsUpdateType,
  parseWindowsVersion,
  readHtmlCells,
  readHtmlTables,
  textOfTables,
  windowsReleases,
  windowsShippedAt,
  windowsUpdateNote,
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
  it("reads every top-level table (the versions and three history tables) as rows of cell text, skipping script, style and comments", () => {
    const tables = readHtmlTables(page);
    expect(tables).toHaveLength(4);
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

  it("skips script and style in any case", () => {
    const table = "<table><tr><td>a</td></tr></table>";
    expect(readHtmlTables(`<SCRIPT>x<table><tr><td>no</td></tr></table></SCRIPT>${table}`)).toEqual([[["a"]]]);
    expect(readHtmlTables(`<Style>x<table><tr><td>no</td></tr></table></STYLE>${table}`)).toEqual([[["a"]]]);
  });

  it("caps a cell that a flood of line breaks would grow", () => {
    const [[[cell]]] = readHtmlTables(`<table><tr><td>${"<br>".repeat(1_000_000)}z</td></tr></table>`);
    expect(cell).toBe("");
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

  it("keeps the row with the later update when a version is listed twice", () => {
    const header = "Version|Availability date|Latest revision date|Latest build";
    const stale = "24H2|2024-10-01|2025-01-01|26100.1";
    const current = "24H2|2024-10-01|2025-09-29|26100.6725";
    for (const rows of [
      [stale, current],
      [current, stale],
    ]) {
      expect(windowsReleases(readHtmlTables(versionsTable(rows, header)))).toEqual([
        {
          version: "24H2",
          availableAt: "2024-10-01T00:00:00.000Z",
          updatedAt: "2025-09-29T00:00:00.000Z",
          build: "26100.6725",
        },
      ]);
    }
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

describe("readHtmlCells", () => {
  it("keeps the text exactly as readHtmlTables reads it, and the href of the first link in a cell", () => {
    const html =
      '<table><tr><th>KB</th></tr><tr><td><a class="x" href="https://support.microsoft.com/help/5000000">KB5000000</a> <a href="https://other.example/">more</a></td><td>plain</td><td><a name="top">no href</a></td></tr></table>';
    const cells = readHtmlCells(html);
    expect(textOfTables(cells)).toEqual(readHtmlTables(html));
    expect(cells[0][1]).toEqual([
      { text: "KB5000000 more", href: "https://support.microsoft.com/help/5000000" },
      { text: "plain" },
      { text: "no href" },
    ]);
  });

  it("reads single-quoted and spaced attributes, and ignores a link outside a cell, an empty href and a long tag", () => {
    const cells = readHtmlCells(
      `<a href="https://outside.example/"></a><table><tr><td><a  HREF = 'https://a.example/x'>a</a></td><td><a href="">b</a></td><td><a title="${"x".repeat(2100)}" href="https://c.example/">c</a></td><td><a data-href="https://d.example/">d</a></td></tr></table>`,
    );
    expect(cells[0][0].map((cell) => cell.href)).toEqual(["https://a.example/x", undefined, undefined, undefined]);
  });
});

describe("parseWindowsUpdateType", () => {
  it("reads B, D and OOB with their month, in any case", () => {
    expect(parseWindowsUpdateType("2026-09 B")).toEqual({ type: "2026-09 B", kind: "B" });
    expect(parseWindowsUpdateType(" 2026-09  d ")).toEqual({ type: "2026-09 D", kind: "D" });
    expect(parseWindowsUpdateType("2026-10 OOB")).toEqual({ type: "2026-10 OOB", kind: "OOB" });
  });

  it("reads nothing else", () => {
    for (const text of [
      "",
      " ",
      "B",
      "2026-09",
      "2026-09 C",
      "2026-09 X",
      "2026-9 B",
      "26-09 B",
      "2026/09 B",
      "2026-09 OOBB",
      "constructor",
      "2026-09 __proto__",
      "abcd-ef B",
    ]) {
      expect(parseWindowsUpdateType(text), text).toBeUndefined();
    }
  });
});

describe("parseWindowsKb", () => {
  it("finds a KB number of four to eight digits", () => {
    expect(parseWindowsKb("KB5000000")).toBe("KB5000000");
    expect(parseWindowsKb("see kb5043080 for details")).toBe("KB5043080");
    expect(parseWindowsKb("KB1234")).toBe("KB1234");
  });

  it("finds none in anything else", () => {
    for (const text of ["", "KB", "KB123", "KB12x", "5000000", "kilobyte 5000000", "KB KB KB"]) {
      expect(parseWindowsKb(text), text).toBeUndefined();
    }
  });
});

describe("windowsUpdateNote", () => {
  const history = (rows: string[], header = "Servicing option|Update type|Availability date|Build|KB article") =>
    readHtmlCells(
      `<table><tr>${header
        .split("|")
        .map((cell) => `<th>${cell}</th>`)
        .join("")}</tr>${rows.map((row) => `<tr>${row}</tr>`).join("")}</table>`,
    );
  const row = (
    type: string,
    build: string,
    kb = '<a href="https://support.microsoft.com/help/5000001">KB5000001</a>',
  ) => `<td>GA</td><td>${type}</td><td>2026-09-09</td><td>${build}</td><td>${kb}</td>`;

  it("maps B, D and OOB to a short label with the table's own KB link", () => {
    const tables = history([
      row("2026-09 D", "26100.6800"),
      row("2026-09 B", "26100.6725", '<a href="https://support.microsoft.com/help/5043080">KB5043080</a>'),
      row("2026-09 OOB", "26100.6700"),
    ]);
    expect(windowsUpdateNote(tables, "26100.6725")).toEqual({
      text: "Security update",
      detail: "2026-09 B: the monthly security update.",
      reference: { label: "KB5043080", url: "https://support.microsoft.com/help/5043080" },
    });
    expect(windowsUpdateNote(tables, "26100.6800")?.text).toBe("Optional preview");
    expect(windowsUpdateNote(tables, "26100.6700")?.text).toBe("Out-of-band fix");
  });

  it("gives no note without a build, for a build no table lists, or when the row's type is unknown", () => {
    const tables = history([row("2026-09 B", "26100.6725"), row("2026-09 Q", "26100.6000")]);
    expect(windowsUpdateNote(tables, undefined)).toBeUndefined();
    expect(windowsUpdateNote(tables, "")).toBeUndefined();
    expect(windowsUpdateNote(tables, "26100.9999")).toBeUndefined();
    expect(windowsUpdateNote(tables, "26100.6000")).toBeUndefined();
    expect(windowsUpdateNote([], "26100.6725")).toBeUndefined();
  });

  it("needs both an Update type and a Build column, and ignores the table of versions", () => {
    expect(
      windowsUpdateNote(history([row("2026-09 B", "26100.6725")], "Servicing option|Kind|Date|Build|KB"), "26100.6725"),
    ).toBeUndefined();
    expect(
      windowsUpdateNote(
        history([row("2026-09 B", "26100.6725")], "Servicing option|Update type|Date|Revision|KB"),
        "26100.6725",
      ),
    ).toBeUndefined();
    expect(
      windowsUpdateNote(readHtmlCells(page.split("<h2>Windows 11, version 26H2</h2>")[0]), "26300.1000"),
    ).toBeUndefined();
  });

  it("works without a KB column, and with a KB cell that has no number or no link", () => {
    const noKb = history(
      [`<td>GA</td><td>2026-09 B</td><td>2026-09-09</td><td>26100.6725</td>`],
      "Servicing option|Update type|Availability date|Build",
    );
    expect(windowsUpdateNote(noKb, "26100.6725")).toEqual({
      text: "Security update",
      detail: "2026-09 B: the monthly security update.",
    });
    const text = history([row("2026-09 B", "26100.6725", "KB5000002")]);
    expect(windowsUpdateNote(text, "26100.6725")?.reference).toEqual({ label: "KB5000002" });
    const empty = history([row("2026-09 B", "26100.6725", "")]);
    expect(windowsUpdateNote(empty, "26100.6725")?.reference).toBeUndefined();
  });

  it("builds no link of its own: only an https link on support.microsoft.com that the cell has is kept", () => {
    for (const href of [
      "http://support.microsoft.com/help/5",
      "https://microsoft.com/help/5",
      "/help/5",
      "javascript:alert(1)",
      "https://user:pw@support.microsoft.com/help/5",
    ]) {
      const tables = history([row("2026-09 B", "26100.6725", `<a href="${href}">KB5000003</a>`)]);
      expect(windowsUpdateNote(tables, "26100.6725")?.reference, href).toEqual({ label: "KB5000003" });
    }
  });

  it("copes with short rows and a table of nothing", () => {
    expect(
      windowsUpdateNote(
        readHtmlCells("<table><tr><th>Update type</th><th>Build</th></tr><tr><td>2026-09 B</td></tr></table>"),
        "26100.6725",
      ),
    ).toBeUndefined();
    expect(windowsUpdateNote(readHtmlCells("<table></table><table><tr></tr></table>"), "26100.6725")).toBeUndefined();
    expect(windowsUpdateNote(readHtmlCells(""), "26100.6725")).toBeUndefined();
  });
});
