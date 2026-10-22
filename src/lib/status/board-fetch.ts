/**
 * How long the page waits for a board before it gives up on the request. The GET is served from the server's
 * cache (or waits on one sweep, bounded by the server's own deadline), so a request that has not answered by
 * now is lost: without a bound it held the live line at "Checking…" until the page was reloaded.
 */
export const BOARD_FETCH_TIMEOUT_MS = 20_000;

/** The Refresh button's forced sweep, which reads every vendor at once and may take longer than a cached GET. */
export const BOARD_REFRESH_TIMEOUT_MS = 30_000;

function timeoutError(ms: number): Error {
  const error = new Error(`Timed out after ${ms} ms`);
  error.name = "TimeoutError";
  return error;
}

/**
 * Runs `run` with a signal that aborts after `ms`, or as soon as `outer` does (with its reason). The timer and the
 * listener on `outer` are gone once the call settles, so nothing of it outlives the request. A plain controller,
 * not AbortSignal.any or AbortSignal.timeout, which older Safari does not have.
 */
export async function withTimeout<T>(
  outer: AbortSignal | undefined,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const forward = () => controller.abort(outer?.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (outer?.aborted) forward();
  else {
    outer?.addEventListener("abort", forward, { once: true });
    timer = setTimeout(() => controller.abort(timeoutError(ms)), ms);
  }
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", forward);
  }
}
