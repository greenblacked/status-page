import { expect, test } from "@playwright/test";

// Times on the board are the viewer's own once the page has hydrated, and UTC before that: the
// server cannot know the viewer's zone, and a hydrating render must print what the server printed.
// The suite pins UTC (playwright.config.ts), so the zone is set here. The `title` of every time is
// the whole moment in UTC, in any zone.

/** The time in the live line: when the board was last checked. */
const asOf = (page: import("@playwright/test").Page) => page.getByTestId("live-bar").locator("time");

test.describe("in Berlin", () => {
  test.use({ timezoneId: "Europe/Berlin", locale: "en-GB" });

  test("shows the viewer's own zone once hydrated, and UTC in the title", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
    const stamp = asOf(page);
    await expect(stamp).toHaveText(/^\d\d:\d\d\sCES?T$/);
    await expect(stamp).toHaveAttribute("title", /^\d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d UTC$/);

    // The same moment: the title's UTC clock is the local clock less the zone's offset (1 h in winter, 2 in summer).
    const iso = (await stamp.getAttribute("datetime")) ?? "";
    expect(iso).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const utc = new Date(iso);
    const title = (await stamp.getAttribute("title")) ?? "";
    expect(
      title.endsWith(
        `${String(utc.getUTCHours()).padStart(2, "0")}:${String(utc.getUTCMinutes()).padStart(2, "0")} UTC`,
      ),
    ).toBe(true);
    const shown = (await stamp.textContent()) ?? "";
    const offset = Number(shown.slice(0, 2)) - utc.getUTCHours();
    expect([1, 2, -22, -23]).toContain(offset);
    expect(shown.endsWith(offset === 2 || offset === -22 ? "CEST" : "CET")).toBe(true);

    // Hydrating from UTC text to local text is not a mismatch.
    expect(problems).toEqual([]);
  });

  test("the server's HTML is UTC, whatever zone asks", async ({ baseURL, browser }) => {
    const context = await browser.newContext({
      baseURL,
      javaScriptEnabled: false,
      timezoneId: "Europe/Berlin",
      locale: "en-GB",
    });
    try {
      const page = await context.newPage();
      await page.goto("/");
      const stamp = asOf(page);
      await expect(stamp).toHaveText(/^\d\d:\d\d\sUTC$/);
      await expect(stamp).toHaveAttribute("title", /UTC$/);
    } finally {
      await context.close();
    }
  });
});

// The whole site is English: a browser set to another language keeps its zone, not its words.
test.describe("in a Russian browser", () => {
  test.use({ timezoneId: "Europe/Moscow", locale: "ru-RU" });

  test("the date and the clock are English, in the viewer's zone", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
    const date = page.locator("header time").first();
    await expect(date).toHaveText(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) \d{1,2} [A-Z][a-z]+$/);
    const stamp = asOf(page);
    await expect(stamp).toHaveText(/^\d\d:\d\d\sGMT\+3$/);

    // The date is the viewer's own day in Moscow, spelled the way the server spells UTC dates.
    const iso = (await date.getAttribute("datetime")) ?? "";
    const moscow = new Date(new Date(iso).getTime() + 3 * 3_600_000);
    const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    await expect(date).toHaveText(
      `${weekdays[moscow.getUTCDay()]} ${moscow.getUTCDate()} ${months[moscow.getUTCMonth()]}`,
    );
  });
});

/** The clock a stamp prints in UTC, from the moment its `datetime` names: "08:04 UTC". */
const utcClock = (iso: string) => {
  const at = new Date(iso);
  return `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC`;
};

/** The printed text with its thin no-break space as a plain one, so it can be set beside `utcClock`. */
const plain = (text: string | undefined) => (text ?? "").replace(/\s/g, " ");

test("in UTC the hydrated text is the server's text, so nothing moves", async ({ page }) => {
  // The stamp is when the snapshot was collected, not the clock. A page load may be served a
  // snapshot past the server's TTL, and the board then refetches at once: a later snapshot, so a
  // later stamp, which is not hydration moving anything (and while it is in flight the bar says
  // "Checking" and prints no time). So the text is not compared with the text of one moment, but
  // with the moment its own `datetime` names: the server's HTML against the server's, the hydrated
  // stamp against the one it holds once the board has settled. The same snapshot has the same text.
  const response = await page.goto("/");
  const html = (await response?.text()) ?? "";
  const server = /data-testid="live-bar".*?<time[^>]*?datetime="([^"]+)"[^>]*>([^<]*)<\/time>/is.exec(html);
  expect(server, "the server's HTML carries the stamp").not.toBeNull();
  expect(plain(server?.[2])).toBe(utcClock(server?.[1] ?? ""));

  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "");
  const bar = page.getByTestId("live-bar");
  await expect(bar).toContainText("Live");
  const stamp = asOf(page);
  await expect(stamp).toHaveText(/^\d\d:\d\d\sUTC$/);
  const [iso, text] = await stamp.evaluate((el) => [el.getAttribute("datetime") ?? "", el.textContent ?? ""]);
  expect(plain(text)).toBe(utcClock(iso));
});
