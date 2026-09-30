import { AsyncLocalStorage } from "node:async_hooks";
import type { HistoryDb } from "./history-store";

export type CloudflareEnv = {
  ROBOTS?: string;
  CF_VERSION_METADATA?: { id: string };
  /** D1 database of daily uptime history; written only by the cron. */
  HISTORY_DB?: HistoryDb;
};

type CloudflareRequestContext = {
  env: CloudflareEnv;
  waitUntil: (promise: Promise<unknown>) => void;
};
const storage = new AsyncLocalStorage<CloudflareRequestContext>();

export function runWithCloudflareContext<T>(context: CloudflareRequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Undefined in Node builds and tests. Used by the robots.txt route. */
export function findCloudflareContext(): CloudflareRequestContext | undefined {
  return storage.getStore();
}
