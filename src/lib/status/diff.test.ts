import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { board, service } from "../../test/fixtures.ts";
import { diffBoards, overallHealth } from "./diff.ts";

describe("diffBoards", () => {
  it("reports only health transitions", () => {
    const previous = board([service("aws", { health: "operational" }), service("gcp", { health: "operational" })]);
    const next = board([
      service("aws", { health: "degraded", summary: "eu-west-1 impact" }),
      service("gcp", { health: "operational" }),
    ]);
    assert.deepEqual(diffBoards(previous, next), [
      {
        id: "aws",
        name: "aws",
        from: "operational",
        to: "degraded",
        summary: "eu-west-1 impact",
      },
    ]);
  });

  it("does not let an unreadable source mask a confirmed degradation", () => {
    assert.equal(
      overallHealth(board([service("aws", { health: "unknown" }), service("gcp", { health: "degraded" })])),
      "degraded",
    );
    assert.equal(
      overallHealth(board([service("aws", { health: "unknown" }), service("gcp", { health: "maintenance" })])),
      "unknown",
    );
  });

  it("treats the worst service as overall health", () => {
    assert.equal(
      overallHealth(board([service("aws", { health: "degraded" }), service("gcp", { health: "outage" })])),
      "outage",
    );
  });

  it("reports a new official version even when health is unchanged", () => {
    const previous = board([
      service("mikrotik", {
        health: "operational",
        meta: { latest: "7.24.3", versions: "RouterOS 7 stable=7.24.3" },
      }),
    ]);
    const next = board([
      service("mikrotik", {
        health: "operational",
        summary: "Latest RouterOS 7.24.4",
        meta: { latest: "7.24.4", versions: "RouterOS 7 stable=7.24.4" },
      }),
    ]);
    assert.deepEqual(diffBoards(previous, next), [
      {
        id: "mikrotik",
        name: "mikrotik",
        from: "operational",
        to: "operational",
        summary: "RouterOS 7 stable 7.24.4",
      },
    ]);
  });

  it("does not report a version that only left the list as a change", () => {
    const previous = board([
      service("android-os", {
        health: "operational",
        meta: { latest: "Android 17", versions: "Android 17=released|Android 16=released" },
      }),
    ]);
    const next = board([
      service("android-os", {
        health: "operational",
        summary: "Latest: Android 17",
        meta: { latest: "Android 17", versions: "Android 17=released" },
      }),
    ]);
    assert.deepEqual(diffBoards(previous, next), []);
  });

  it("reports a major version the Android page adds as a release, and the one that drops off as nothing more", () => {
    const previous = board([
      service("android-os", {
        health: "operational",
        meta: { latest: "Android 17", versions: "Android 17=released|Android 16=released|Android 15=released" },
      }),
    ]);
    const next = board([
      service("android-os", {
        health: "operational",
        summary: "Latest: Android 18",
        meta: { latest: "Android 18", versions: "Android 18=released|Android 17=released|Android 16=released" },
      }),
    ]);
    assert.deepEqual(diffBoards(previous, next), [
      {
        id: "android-os",
        name: "android-os",
        from: "operational",
        to: "operational",
        summary: "Android 18 released",
      },
    ]);
  });

  it("still reports a health change when a version leaves the list", () => {
    const previous = board([
      service("android-os", { health: "operational", meta: { latest: "A", versions: "A=1|B=2" } }),
    ]);
    const next = board([service("android-os", { health: "unknown", summary: "Couldn't read", meta: undefined })]);
    assert.deepEqual(
      diffBoards(previous, next).map((change) => change.to),
      ["unknown"],
    );
  });
});
