import { existsSync, readFileSync, rmSync } from "node:fs";
import type { FullConfig } from "@playwright/test";
import type { BoardSnapshot } from "../../src/lib/status/types.ts";
import { vendorLogPath } from "./vendor-log.ts";

type Entry = { kind: "active" | "refused"; host?: string; path?: string };

const entries = (file: string): Entry[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Entry)
    : [];

/**
 * Proves, before the first test, that the preview server cannot reach a vendor (support/no-vendors.mjs is
 * loaded into it): asks it for a board and checks that every one of its vendor requests was refused and that
 * the board it built is all Unknown. If the server were reading live vendors, this fails instead of the suite
 * quietly depending on them. The returned function reports the same count after the last test.
 */
export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const baseURL = config.projects[0].use.baseURL ?? "";
  const port = Number(new URL(baseURL).port);
  const log = vendorLogPath(port);

  const response = await fetch(new URL("/api/status.json", baseURL));
  const board = (await response.json()) as BoardSnapshot;
  const unknown = board.services.filter((service) => service.health === "unknown").length;
  const refused = entries(log).filter((entry) => entry.kind === "refused");
  if (
    entries(log).every((entry) => entry.kind !== "active") ||
    refused.length === 0 ||
    unknown !== board.services.length
  ) {
    throw new Error(
      `The preview server is not running with e2e/support/no-vendors.mjs (${unknown} of ${board.services.length} services Unknown, ${refused.length} vendor requests refused). The browser tests must not read live vendors: stop whatever holds port ${port}, or set PLAYWRIGHT_PORT.`,
    );
  }
  const hosts = new Set(refused.map((entry) => entry.host));
  console.log(
    `e2e: the server is cut off from the vendors (${refused.length} requests to ${hosts.size} hosts refused while building a board, all ${unknown} services Unknown)`,
  );

  return async () => {
    const all = entries(log).filter((entry) => entry.kind === "refused");
    console.log(`e2e: ${all.length} vendor requests refused in all, 0 reached a vendor`);
    rmSync(log, { force: true });
  };
}
