import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import { fetchBoardHistory, serviceHistoryDays } from "@/lib/status/board-history";
import type { HistoryDay, PublicHistory } from "@/lib/status/history";

/** History moves by whole UTC days, so it is asked for far less often than the board. */
export const HISTORY_REFRESH_MS = 10 * 60_000;

export const BoardHistoryContext = createContext<PublicHistory | undefined>(undefined);

/**
 * Query options for the board history. The fetch rejects on any failure, so
 * a failed refetch leaves the previous good data in the cache instead of
 * replacing it with an empty document. Queries never run during SSR.
 */
export function boardHistoryQueryOptions(enabled: boolean) {
  return {
    queryKey: ["status-history"],
    queryFn: () => fetchBoardHistory(fetch, { throwOnError: true }),
    enabled,
    staleTime: HISTORY_REFRESH_MS,
    refetchInterval: HISTORY_REFRESH_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  } as const;
}

/**
 * Fetches public GET /api/history.json for the board when `enabled`. A
 * disabled provider makes no request; a failed or slow first fetch leaves the
 * context without days, so every card renders without a strip, and a failed
 * refetch keeps the last good days.
 */
export function BoardHistoryQueryProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const historyQuery = useQuery(boardHistoryQueryOptions(enabled));

  return <BoardHistoryContext.Provider value={historyQuery.data}>{children}</BoardHistoryContext.Provider>;
}

/**
 * The board's history provider. Neither build collects any history today
 * (`/api/history.json` is an empty compatibility document), so unless the
 * build sets `VITE_STATUS_HISTORY=1` this returns `children` untouched: no
 * request, no context value, and the bundler drops the query code along with
 * the strip. The env check is an inline literal so Vite can replace it at
 * build time.
 */
export function BoardHistoryProvider({ children }: { children: ReactNode }) {
  if (import.meta.env.VITE_STATUS_HISTORY !== "1") return children;
  return <BoardHistoryQueryProvider enabled>{children}</BoardHistoryQueryProvider>;
}

/** Days for one service from the board history context; empty when missing. */
export function useServiceHistoryDays(serviceId: string): HistoryDay[] {
  const history = useContext(BoardHistoryContext);
  return serviceHistoryDays(history, serviceId);
}
