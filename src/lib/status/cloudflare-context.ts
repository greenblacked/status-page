import { AsyncLocalStorage } from "node:async_hooks";

export type CloudflareEnv = {
  ROBOTS?: string;
  CF_VERSION_METADATA?: { id: string };
};

export type CloudflareRequestContext = {
  env: CloudflareEnv;
  waitUntil: (promise: Promise<unknown>) => void;
  /** The request's origin (`https://host`), which keys the board snapshot shared through the Cache API. */
  origin?: string;
};
const storage = new AsyncLocalStorage<CloudflareRequestContext>();

export function runWithCloudflareContext<T>(context: CloudflareRequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Undefined in Node builds and tests. Used by the robots.txt route and the board cache. */
export function findCloudflareContext(): CloudflareRequestContext | undefined {
  return storage.getStore();
}
