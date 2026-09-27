import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";
import { fetchBoardHistory, serviceHistoryDays } from "@/lib/status/board-history";
import type { HistoryDay, PublicHistory } from "@/lib/status/history";
import { CACHE_TTL_MS, nextRefetchAt, pickRefetchJitter } from "@/lib/status/schedule";

const BoardHistoryContext = createContext<PublicHistory | undefined>(undefined);

/**
 * Fetches public GET /api/history.json for the board. Failure or a cold
 * document leaves the context empty so every card renders without a strip.
 */
export function BoardHistoryProvider({ children }: { children: ReactNode }) {
  const [refetchJitter] = useState(() => pickRefetchJitter());
  const historyQuery = useQuery({
    queryKey: ["status-history"],
    queryFn: () => fetchBoardHistory(),
    staleTime: CACHE_TTL_MS,
    refetchInterval: () => {
      const current = Date.now();
      return nextRefetchAt(current, refetchJitter) - current;
    },
    refetchIntervalInBackground: true,
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
