import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FullConfig } from "@playwright/test";
import type { BoardSnapshot } from "../../src/lib/status/types.ts";
import { VENDOR_LOG_PREFIX, vendorLogPath } from "./vendor-log.ts";

type Entry = { kind: "active" | "served" | "refused"; host?: string; path?: string };

const entries = (file: string): Entry[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Entry)
    : [];

const count = (list: Entry[], kind: Entry["kind"]) => list.filter((entry) => entry.kind === kind).length;

/**
 * Proves, before the first test, that the preview server cannot reach a vendor (support/no-vendors.mjs is
 * loaded into it): asks it for a board and checks that its vendor requests were answered from the canned
 * payloads or refused, and that the board it built has states on it (not all Unknown), so the first render
 * and the hydration after it are tested with outages, incidents and release lines. If the server were reading
 * live vendors, or the preload did not load, this fails instead of the suite quietly depending on them. The
 * returned function reports the counts of the whole run after the last test.
 */
export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const baseURL = config.projects[0].use.baseURL ?? "";
  const port = Number(new URL(baseURL).port);
  const run = process.env.E2E_RUN;
  if (!run) throw new Error("playwright.config.ts did not set E2E_RUN, the run's id for the vendor log.");
  const log = vendorLogPath(port, run);

  // The logs of earlier runs (a killed run never reaches its teardown) are of no use to this one.
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith(`${VENDOR_LOG_PREFIX}${port}-`) && join(tmpdir(), name) !== log) {
      rmSync(join(tmpdir(), name), { force: true });
    }
  }

  const response = await fetch(new URL("/api/status.json", baseURL));
  const board = (await response.json()) as BoardSnapshot;
  const unknown = board.services.filter((service) => service.health === "unknown").length;
  const seen = entries(log);
  const served = count(seen, "served");
  const refused = count(seen, "refused");
  if (count(seen, "active") === 0 || served + refused === 0 || unknown === board.services.length) {
    throw new Error(
      `The preview server is not running with e2e/support/no-vendors.mjs (${unknown} of ${board.services.length} services Unknown, ${served} vendor requests answered from fixtures, ${refused} refused). The browser tests must not read live vendors: stop whatever holds port ${port}, or set PLAYWRIGHT_PORT.`,
    );
  }
  console.log(
    `e2e: the server is cut off from the vendors (building a board: ${served} requests answered from fixtures, ${refused} refused, ${board.services.length - unknown} of ${board.services.length} services with a state)`,
  );

  return async () => {
    const all = entries(log);
    console.log(
      `e2e: ${count(all, "served")} vendor requests answered from fixtures and ${count(all, "refused")} refused in all; none left the machine (the stub has no other route)`,
    );
    rmSync(log, { force: true });
  };
}
