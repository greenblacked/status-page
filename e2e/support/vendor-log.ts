import { tmpdir } from "node:os";
import { join } from "node:path";

/** The prefix of every vendor log, so a run can clear the ones an earlier run left behind. */
export const VENDOR_LOG_PREFIX = "status-page-e2e-vendors-";

/**
 * Where the preview server (support/no-vendors.mjs) writes every vendor request it answered or refused, one JSON
 * line each. One file per port and per run (`run` is a nonce made once by playwright.config.ts), so a run never
 * reads the lines of an earlier one, and two runs side by side do not mix.
 */
export const vendorLogPath = (port: number, run: string): string =>
  join(tmpdir(), `${VENDOR_LOG_PREFIX}${port}-${run}.log`);
