import { describe, expect, it } from "vitest";
import { APP_NAME, CATALOG, CATALOG_BY_ID, CATEGORIES, SITE_ORIGIN } from "./catalog";

describe("catalog", () => {
  it("names the site plainly and gives its origin without a trailing slash", () => {
    expect(APP_NAME).toBe("Status");
    expect(SITE_ORIGIN).toMatch(/^https:\/\/[^/]+$/);
  });

  it("calls the release trackers Releases, and lists the categories in the order the filter shows them", () => {
    expect(CATEGORIES.map((category) => category.label)).toEqual(["Cloud", "Gaming", "Platforms", "AI", "Releases"]);
    expect(CATEGORIES.find((category) => category.id === "updates")?.label).toBe("Releases");
  });

  it("has fourteen services, each once, every one in a category", () => {
    expect(CATALOG).toHaveLength(14);
    expect(new Set(CATALOG.map((entry) => entry.id)).size).toBe(14);
    const categories = new Set(CATEGORIES.map((category) => category.id));
    for (const entry of CATALOG) expect(categories.has(entry.category)).toBe(true);
    expect(CATALOG_BY_ID.gcp.name).toBe("Google Cloud");
  });
});
