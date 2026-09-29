import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";
import { fetchBoardHistory, serviceHistoryDays } from "@/lib/status/board-history";
import type { HistoryDay, PublicHistory } from "@/lib/status/history";

/**
 * Whether this build asks for uptime history at all. Neither build collects
 * any today (`/api/history.json` is an empty compatibility document), so the
 * board makes no request and the cards look as they do without this file.
 * Build with `VITE_STATUS_HISTORY=1` once a history source exists.
 */
export const HISTORY_ENABLED = import.meta.env.VITE_STATUS_HISTORY === "1";

/** History moves by whole UTC days, so it is asked for far less often than the board. */
export const HISTORY_REFRESH_MS = 10 * 60_000;

export const BoardHistoryContext = createContext<PublicHistory | undefined>(undefined);

/**
 * Fetches public GET /api/history.json for the board when `enabled`. A
 * disabled provider makes no request; a failed, slow or empty one leaves the
 * context without days, so every card renders without a strip.
 */
export function BoardHistoryProvider({
  children,
  enabled = HISTORY_ENABLED,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const historyQuery = useQuery({
    queryKey: ["status-history"],
    queryFn: () => fetchBoardHistory(),
    enabled,
    staleTime: HISTORY_REFRESH_MS,
    refetchInterval: HISTORY_REFRESH_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  return <BoardHistoryContext.Provider value={historyQuery.data}>{children}</BoardHistoryContext.Provider>;
}

/** Days for one service from the board history context; empty when missing. */
export function useServiceHistoryDays(serviceId: string): HistoryDay[] {
  const history = useContext(BoardHistoryContext);
  return serviceHistoryDays(history, serviceId);
}
