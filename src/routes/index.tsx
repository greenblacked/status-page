import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { BoardHistoryProvider } from "@/components/status/board-history-provider";
import { BoardView } from "@/components/status/board-view";
import { loadStatusBoardForPage } from "@/lib/status/board";
import { type BoardFilters, filtersFromSearch, parseBoardSearch, searchFromFilters } from "@/lib/status/filters";

export const Route = createFileRoute("/")({
  validateSearch: parseBoardSearch,
  loader: () => loadStatusBoardForPage(),
  staleTime: Infinity,
  shouldReload: false,
  component: Home,
});

function Home() {
  const board = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // Read once: the board owns its filters from here on and the URL follows them, so a search that changes the
  // address must not hand the board a new (equal) object that renders the whole of it again.
  const [initialFilters] = useState(() => filtersFromSearch(search));
  // Replace, not push: typing a search should not fill the Back button, and
  // keeping the scroll position means a filter change does not jump the page.
  const onFiltersChange = useCallback(
    (filters: BoardFilters) => void navigate({ search: searchFromFilters(filters), replace: true, resetScroll: false }),
    [navigate],
  );
  return (
    <BoardHistoryProvider>
      <BoardView initial={board} initialFilters={initialFilters} onFiltersChange={onFiltersChange} />
    </BoardHistoryProvider>
  );
}
