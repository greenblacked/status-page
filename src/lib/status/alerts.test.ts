import { describe, expect, it } from "vitest";
import { board, service } from "../../test/fixtures.ts";
import { type AlertDebounce, alertChanges, alertFor, emptyAlertDebounce } from "./alerts";
import type { Health } from "./types";

describe("alertFor", () => {
  const change = (from: Health, to: Health, name = "Grok") => alertFor({ id: "grok", name, from, to, summary: "s" });

  it("says what the service is now, in one shape", () => {
    expect(change("operational", "degraded").title).toBe("Grok is degraded");
    expect(change("operational", "outage").title).toBe("Grok is down");
    expect(change("operational", "maintenance").title).toBe("Grok is in maintenance");
    expect(change("operational", "unknown").title).toBe("Couldn't read Grok");
  });

  it("says a service is back, or that a release is new", () => {
    expect(change("degraded", "operational", "Steam").title).toBe("Steam is back");
    expect(change("operational", "operational", "MikroTik RouterOS").title).toBe("New release: MikroTik RouterOS");
  });

  it("carries the summary as the body and the service as the tag, so a newer alert replaces an older one", () => {
    expect(alertFor({ id: "gcp", name: "Google Cloud", from: "operational", to: "outage", summary: "Down" })).toEqual({
      title: "Google Cloud is down",
      body: "Down",
      tag: "status-bar:gcp",
    });
  });
});

describe("alertChanges", () => {
  // Feeds a service's health through consecutive board updates and returns,
  // per update, the alerts as "from>to".
  function run(healths: Health[], summaries: string[] = []): string[][] {
    let state: AlertDebounce = emptyAlertDebounce();
    const out: string[][] = [];
    for (let i = 1; i < healths.length; i += 1) {
      const step = alertChanges(
        state,
        board([service("gcp", { health: healths[i - 1] })]),
        board([service("gcp", { health: healths[i], summary: summaries[i] ?? "" })]),
      );
      state = step.state;
      out.push(step.changes.map((change) => `${change.from}>${change.to}`));
    }
    return out;
  }

  it("alerts at once for a real outage, a degradation, maintenance and a recovery", () => {
    expect(run(["operational", "outage", "degraded", "operational", "maintenance"])).toEqual([
      ["operational>outage"],
      ["outage>degraded"],
      ["degraded>operational"],
      ["operational>maintenance"],
    ]);
  });

  it("does not alert for the first update into Unknown, and alerts on the second in a row", () => {
    expect(run(["operational", "unknown", "unknown"])).toEqual([[], ["operational>unknown"]]);
  });

  it("does not alert at all for a blip: outage, unknown for one update, outage again", () => {
    expect(run(["outage", "unknown", "outage", "outage"])).toEqual([[], [], []]);
  });

  it("alerts when a service comes back from Unknown only after two updates", () => {
    expect(run(["operational", "unknown", "unknown", "operational", "operational"])).toEqual([
      [],
      ["operational>unknown"],
      [],
      ["unknown>operational"],
    ]);
  });

  it("a real transition out of a pending Unknown alerts immediately, from the last alerted state", () => {
    // degraded, one unknown update (not alerted), then outage: alert degraded>outage now.
    expect(run(["degraded", "unknown", "outage"])).toEqual([[], ["degraded>outage"]]);
  });

  it("a real transition clears a pending Unknown", () => {
    expect(run(["outage", "unknown", "operational", "operational"])).toEqual([[], ["outage>operational"], []]);
  });

  it("restarts the count when the pending target changes", () => {
    expect(run(["unknown", "unknown", "operational", "degraded", "degraded"])).toEqual([
      [],
      [],
      [],
      ["unknown>degraded"],
    ]);
  });

  it("keeps separate counts per service", () => {
    let state = emptyAlertDebounce();
    const a = (health: Health) => service("aws", { health });
    const g = (health: Health) => service("gcp", { health });
    let step = alertChanges(state, board([a("operational"), g("operational")]), board([a("unknown"), g("outage")]));
    state = step.state;
    expect(step.changes.map((change) => `${change.id}:${change.from}>${change.to}`)).toEqual([
      "gcp:operational>outage",
    ]);
    step = alertChanges(state, board([a("unknown"), g("outage")]), board([a("unknown"), g("outage")]));
    expect(step.changes.map((change) => `${change.id}:${change.from}>${change.to}`)).toEqual([
      "aws:operational>unknown",
    ]);
  });

  it("still announces a new release straight away, and carries the summary of a real change", () => {
    const tracker = (versions: string, health: Health = "operational") =>
      service("mikrotik", { health, summary: "Latest", meta: { versions } });
    const release = alertChanges(
      emptyAlertDebounce(),
      board([tracker("RouterOS 7 stable=7.20")]),
      board([tracker("RouterOS 7 stable=7.21")]),
    );
    expect(release.changes).toEqual([
      { id: "mikrotik", name: "mikrotik", from: "operational", to: "operational", summary: "RouterOS 7 stable 7.21" },
    ]);
    const down = alertChanges(
      emptyAlertDebounce(),
      board([service("gcp", { health: "operational" })]),
      board([service("gcp", { health: "outage", summary: "Compute down" })]),
    );
    expect(down.changes).toEqual([
      { id: "gcp", name: "gcp", from: "operational", to: "outage", summary: "Compute down" },
    ]);
  });

  it("ignores a service the previous board did not have", () => {
    const step = alertChanges(emptyAlertDebounce(), board([]), board([service("gcp", { health: "outage" })]));
    expect(step.changes).toEqual([]);
  });
});
