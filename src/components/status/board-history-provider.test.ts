import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardHistoryProvider, BoardHistoryQueryProvider, boardHistoryQueryOptions } from "./board-history-provider";

// The repo has no DOM environment or React testing library, so the provider
// is checked through the query options it hands to React Query (driven by a
// real QueryObserver, as useQuery does) and through a server render.

function historyBody(up: number) {
  return {
    schema: 1,
    updatedAt: "2026-09-27T12:00:00.000Z",
    timezone: "UTC",
    retentionDays: 30,
    services: { aws: { days: [{ date: "2026-09-27", worst: "operational", samples: 4, up }] } },
  };
}

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("BoardHistoryProvider", () => {
  it("never fetches while disabled", async () => {
    const fetchStub = vi.fn(async () => Response.json(historyBody(1)));
    vi.stubGlobal("fetch", fetchStub);
    const queryClient = client();
    const observer = new QueryObserver(queryClient, boardHistoryQueryOptions(false));
    const unsubscribe = observer.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    unsubscribe();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(observer.getCurrentResult().data).toBeUndefined();
  });

  it("fetches once when enabled", async () => {
    const fetchStub = vi.fn(async () => Response.json(historyBody(1)));
    vi.stubGlobal("fetch", fetchStub);
    const queryClient = client();
    const observer = new QueryObserver(queryClient, boardHistoryQueryOptions(true));
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    unsubscribe();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().data?.services.aws?.days).toHaveLength(1);
  });

  it("keeps the last good data when a refetch fails", async () => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(historyBody(0.5)))
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ schema: 99 }));
    vi.stubGlobal("fetch", fetchStub);
    const queryClient = client();
    const observer = new QueryObserver(queryClient, boardHistoryQueryOptions(true));
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    const good = observer.getCurrentResult().data;
    expect(good?.services.aws?.days[0]?.up).toBe(0.5);

    // A timeout, a non-OK status and a malformed body each fail the refetch.
    for (let call = 2; call <= 4; call++) {
      await observer.refetch();
      expect(fetchStub).toHaveBeenCalledTimes(call);
      const result = observer.getCurrentResult();
      expect(result.isError).toBe(true);
      expect(result.data).toBe(good);
    }
    unsubscribe();
  });

  it("does not fetch during a server render, enabled or not", () => {
    const fetchStub = vi.fn(async () => Response.json(historyBody(1)));
    vi.stubGlobal("fetch", fetchStub);
    for (const enabled of [true, false]) {
      const html = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: client() },
          createElement(
            BoardHistoryQueryProvider,
            { enabled } as ComponentProps<typeof BoardHistoryQueryProvider>,
            createElement("p", null, "board"),
          ),
        ),
      );
      expect(html).toBe("<p>board</p>");
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("is a pass-through, needing no query client, unless the build sets the flag", () => {
    const fetchStub = vi.fn(async () => Response.json(historyBody(1)));
    vi.stubGlobal("fetch", fetchStub);
    for (const flag of [undefined, "", "0", "true"]) {
      vi.stubEnv("VITE_STATUS_HISTORY", flag as string);
      const html = renderToStaticMarkup(createElement(BoardHistoryProvider, null, createElement("p", null, "board")));
      expect(html).toBe("<p>board</p>");
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("mounts the query provider when the build sets the flag", () => {
    vi.stubEnv("VITE_STATUS_HISTORY", "1");
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: client() },
        createElement(BoardHistoryProvider, null, createElement("p", null, "board")),
      ),
    );
    expect(html).toBe("<p>board</p>");
  });
});
