import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOARD_FETCH_TIMEOUT_MS, BOARD_REFRESH_TIMEOUT_MS, withTimeout } from "./board-fetch.ts";

/** A request that never answers on its own: like fetch, it settles only when its signal aborts, with the reason. */
function stalled(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a stalled board request less time than a forced sweep", () => {
    expect(BOARD_FETCH_TIMEOUT_MS).toBe(20_000);
    expect(BOARD_REFRESH_TIMEOUT_MS).toBe(30_000);
  });

  it("aborts the request once its time is up, with a TimeoutError", async () => {
    let inner: AbortSignal | undefined;
    const result = withTimeout(undefined, 1_000, (signal) => {
      inner = signal;
      return stalled(signal);
    });
    const settled = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(999);
    expect(inner?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(inner?.aborted).toBe(true);
    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("TimeoutError");
  });

  it("passes an abort from outside on to the request, with its reason", async () => {
    const outer = new AbortController();
    let inner: AbortSignal | undefined;
    const result = withTimeout(outer.signal, 1_000, (signal) => {
      inner = signal;
      return stalled(signal);
    });
    const settled = result.catch((error: unknown) => error);
    const reason = new Error("cancelled");
    outer.abort(reason);
    expect(inner?.aborted).toBe(true);
    expect(await settled).toBe(reason);
    // The timer is gone with it: nothing is left to fire.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts aborted when the outer signal already is", async () => {
    const outer = new AbortController();
    outer.abort(new Error("gone"));
    const run = vi.fn((signal: AbortSignal) => stalled(signal));
    await expect(withTimeout(outer.signal, 1_000, run)).rejects.toThrow("gone");
    expect(run.mock.calls[0]?.[0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer when the request answers in time", async () => {
    const result = await withTimeout(undefined, 1_000, async () => "board");
    expect(result).toBe("board");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer when the request fails on its own", async () => {
    await expect(
      withTimeout(undefined, 1_000, async () => {
        throw new Error("502");
      }),
    ).rejects.toThrow("502");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the listener it put on the outer signal", async () => {
    const outer = new AbortController();
    const add = vi.spyOn(outer.signal, "addEventListener");
    const remove = vi.spyOn(outer.signal, "removeEventListener");
    await withTimeout(outer.signal, 1_000, async () => "board");
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[0]).toBe("abort");
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
    // And a later abort of the outer signal reaches nothing of this call.
    const inner = vi.fn();
    await withTimeout(outer.signal, 1_000, async (signal) => {
      signal.addEventListener("abort", inner);
      return "board";
    });
    outer.abort();
    expect(inner).not.toHaveBeenCalled();
  });
});
