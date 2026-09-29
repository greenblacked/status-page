import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
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
  // Replace, not push: typing a search should not fill the Back button, and
  // keeping the scroll position means a filter change does not jump the page.
  const onFiltersChange = useCallback(
    (filters: BoardFilters) => void navigate({ search: searchFromFilters(filters), replace: true, resetScroll: false }),
    [navigate],
  );
  return <BoardView initial={board} initialFilters={filtersFromSearch(search)} onFiltersChange={onFiltersChange} />;
}
