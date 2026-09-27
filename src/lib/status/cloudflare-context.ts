import { AsyncLocalStorage } from "node:async_hooks";
import type { CloudflareEnv } from "./kv-snapshot-store";

/**
 * The Cloudflare bindings and `ExecutionContext.waitUntil` for the request
 * or scheduled event currently running. TanStack Start's own request context
 * already relies on AsyncLocalStorage under `nodejs_compat` (see the comment
 * in wrangler.jsonc), so this uses the same mechanism rather than inventing
 * a second way to thread per-request values through the app: a Workers
 * module worker's `fetch`/`scheduled` exports are the only place that
 * receive `env` and `ctx` directly, and board-snapshot.ts's readers are
 * created lazily deep inside route and server-function handlers that never
 * see either.
 */
export type CloudflareRequestContext = {
  env: CloudflareEnv;
  waitUntil: (promise: Promise<unknown>) => void;
};

const storage = new AsyncLocalStorage<CloudflareRequestContext>();

export function runWithCloudflareContext<T>(context: CloudflareRequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getCloudflareContext(): CloudflareRequestContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error("getCloudflareContext() called outside a Cloudflare Workers request or scheduled event");
  }
  return context;
}
