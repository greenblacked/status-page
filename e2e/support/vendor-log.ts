import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where the preview server (support/no-vendors.mjs) writes the vendor requests it refused, one JSON line each. One file per port, so two runs side by side do not mix. */
export const vendorLogPath = (port: number): string => join(tmpdir(), `status-page-e2e-vendors-${port}.log`);
