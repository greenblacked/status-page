import { describe, expect, it } from "vitest";
import { alertFor } from "./alerts";

describe("alertFor", () => {
  it("names the new state, recovery, or a release", () => {
    expect(alertFor({ id: "gcp", name: "Google Cloud", from: "operational", to: "outage", summary: "Down" })).toEqual({
      title: "Google Cloud: Outage",
      body: "Down",
      tag: "status-bar:gcp",
    });
    expect(
      alertFor({ id: "gcp", name: "Google Cloud", from: "degraded", to: "operational", summary: "ok" }).title,
    ).toBe("Google Cloud recovered");
    expect(
      alertFor({ id: "mikrotik", name: "MikroTik RouterOS", from: "operational", to: "operational", summary: "7.21" })
        .title,
    ).toBe("MikroTik RouterOS: new release");
  });
});
