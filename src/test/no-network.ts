// A setup file of every unit test (vitest.config.ts, setupFiles): a fetch to any host but this machine fails at
// once, so a test that forgot to stub fetch fails by name instead of quietly reading a live vendor (or timing out
// where there is no network). A local server the test starts itself (node:http on 127.0.0.1) is still reached.
//
// The guard wraps the real fetch and becomes the global one, so vi.stubGlobal("fetch", ...) replaces it as before,
// and vi.unstubAllGlobals() (or unstubGlobals in the config, after every test) puts the guard back, not the real fetch.

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Marks the guard, so that a setup file run again in the same worker does not wrap it twice. */
const GUARD = Symbol.for("status-page.no-network");

type Guarded = typeof fetch & { [GUARD]?: true };

function hostOf(input: RequestInfo | URL): string | undefined {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(href).hostname;
  } catch {
    // Not an absolute URL: the real fetch refuses it with its own error.
    return undefined;
  }
}

if (!(globalThis.fetch as Guarded)[GUARD]) {
  const realFetch = globalThis.fetch;
  const guarded: Guarded = async (input, init) => {
    const host = hostOf(input);
    if (host !== undefined && !LOCAL_HOSTS.has(host)) {
      throw new TypeError(`unit tests must not reach the network: ${host}`);
    }
    return realFetch(input, init);
  };
  guarded[GUARD] = true;
  globalThis.fetch = guarded;
}
