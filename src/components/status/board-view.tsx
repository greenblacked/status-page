import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { AlertsButton, FilterBar, RefreshButton, SearchField, WhileBarUp } from "@/components/status/board-controls";
import { BoardSections } from "@/components/status/board-sections";
import { CompactHeader, useSearchDock } from "@/components/status/compact-header";
import { prefersReducedMotion, useWanderLight, withCardMotion } from "@/components/status/effects";
import { Hero } from "@/components/status/hero";
import { useHoldPlace } from "@/components/status/hold-place";
import { LensField } from "@/components/status/lens-field";
import { LiveBar, nextInText, useFreshness } from "@/components/status/live-bar";
import { PeriodDial } from "@/components/status/period-dial";
import { SettingsDialog } from "@/components/status/settings-dialog";
import { SiteFooter } from "@/components/status/site-footer";
import { UpdateFeed } from "@/components/status/update-feed";
import { useBoardAlerts } from "@/components/status/use-alerts";
import { useBackground } from "@/components/status/use-background";
import { useNow } from "@/components/status/use-now";
import { useReduceGlass } from "@/components/status/use-reduce-glass";
import { useShortcuts, useSingleKeyShortcuts } from "@/components/status/use-shortcuts";
import { useStarred } from "@/components/status/use-starred";
import { useTiltLighting } from "@/components/status/use-tilt-lighting";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchStatusBoard, refreshStatusBoard } from "@/lib/status/board";
import { APP_NAME } from "@/lib/status/catalog";
import { createDockStore } from "@/lib/status/dock";
import {
  type BoardFilters,
  DEFAULT_FILTERS,
  emptyBoardMessage,
  filtersToReveal,
  matchesFilters,
  resultsAnnouncement,
} from "@/lib/status/filters";
import { documentTitle, groupServices, serviceAnchor } from "@/lib/status/layout";
import { emptyPulseStore, loadPulseStore, type PulseStore, savePulseStore, syncPulse } from "@/lib/status/pulse";
import { CACHE_TTL_MS, lastPulseAt, nextRefetchAt, parseTimestamp, pickRefetchJitter } from "@/lib/status/schedule";
import { starredFirst } from "@/lib/status/starred";
import type { BoardSnapshot, CategoryId, ServiceId, ServiceSnapshot } from "@/lib/status/types";
import { verdict as verdictOf } from "@/lib/status/verdict";

// Long enough for a search to settle between keystrokes.
const ANNOUNCE_DELAY_MS = 700;
// A chip's card renders in the commit after its filters clear; one that has
// not turned up by now is not coming.
const REVEAL_TIMEOUT_MS = 1_000;

export function BoardView({
  initial,
  initialFilters,
  onFiltersChange,
}: {
  initial: BoardSnapshot;
  initialFilters: BoardFilters;
  /** Called after every filter change, to mirror the filters into the URL. */
  onFiltersChange: (filters: BoardFilters) => void;
}) {
  const queryClient = useQueryClient();
  const now = useNow();
  // Local state drives the board; the URL follows it. Reading the filters
  // back from the URL would make every keystroke wait on a router update.
  const [filters, setFilters] = useState(initialFilters);
  const { query, issuesOnly, starredOnly } = filters;
  const updateFilters = (patch: Partial<BoardFilters>) => setFilters((current) => ({ ...current, ...patch }));
  const [store, setStore] = useState<PulseStore | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const manualRefreshInFlight = useRef(false);
  const mainRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLElement>(null);
  // The dock's two discrete states live outside this component: the board must not render mid-move.
  const [dock] = useState(createDockStore);
  useSearchDock({ hostRef: bodyRef, dockRef, barRef, slotRef, chipsRef, store: dock });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const singleKey = useSingleKeyShortcuts();
  const reduceGlass = useReduceGlass();
  const background = useBackground();
  // The light only draws on Glass and Full, and Reduce glass takes it away everywhere.
  const tilt = useTiltLighting({ paused: reduceGlass.enabled || background.value === "quiet" });
  useWanderLight(mainRef);
  // Chosen once per page load: the tab keeps its own spot in every slot.
  const [refetchJitter] = useState(() => pickRefetchJitter());

  const boardQuery = useQuery({
    queryKey: ["status-board"],
    // The cached GET, not the forcing POST. With `refreshStatusBoard` here
    // every open tab forced its own full vendor sweep every two minutes, so
    // the 45s server cache never served anyone and load on the vendor APIs
    // scaled with the number of viewers. Forcing is for the Refresh button.
    queryFn: () => fetchStatusBoard(),
    initialData: initial,
    // The page may have rendered from a snapshot past the server TTL (see
    // loadStatusBoardForPage). Dating the initial data by when it was
    // collected makes that one case refetch on mount; a fresh render does not.
    initialDataUpdatedAt: Date.parse(initial.generatedAt),
    // A fixed interval ran from whenever this page loaded, while the
    // countdown and the server's snapshots follow the two-minute wall-clock
    // slots, so "Next update 0:00" came and went without a fetch. Recomputed
    // after every fetch, this lands each refetch where the countdown ends.
    refetchInterval: () => {
      const current = Date.now();
      return nextRefetchAt(current, refetchJitter) - current;
    },
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: true,
    staleTime: CACHE_TTL_MS,
  });

  const board = boardQuery.data ?? initial;
  const verdict = useMemo(() => verdictOf(board), [board]);
  const checkedAt = parseTimestamp(board.generatedAt);
  const alerts = useBoardAlerts(board);
  const { starred, ready: starsReady, toggle: toggleStar } = useStarred();
  const pulseStore = store ?? emptyPulseStore();
  // Recent changes follows Needs a look (or leads the board when nothing needs a look).
  useHoldPlace(mainRef, store?.pulses);
  const feed = <UpdateFeed pulses={pulseStore.pulses} />;
  const changedIds = new Set(
    (pulseStore.pulses[0]?.opening ? [] : (pulseStore.pulses[0]?.changes ?? [])).map((change) => change.id),
  );

  const slot = now > 0 ? lastPulseAt(now) : null;

  // Says the board's handlers are attached. The server's markup paints, and
  // takes clicks that go nowhere, before React hydrates it; the end-to-end
  // tests wait for this attribute (e2e/board.spec.ts) instead of guessing.
  useEffect(() => {
    document.documentElement.dataset.hydrated = "";
  }, []);

  useEffect(() => {
    if (slot === null) return;
    const existing = store ?? loadPulseStore();
    const next = syncPulse(board, slot, existing);
    if (next !== existing) savePulseStore(next);
    if (store === null || next !== existing) setStore(next);
  }, [board, slot, store]);

  const firstFilters = useRef(filters);
  useEffect(() => {
    // The URL already says what the board opened with.
    if (filters === firstFilters.current) return;
    onFiltersChange(filters);
  }, [filters, onFiltersChange]);

  // The tab shows the attention count, so a background tab still says
  // something broke. The server-rendered <title> stays the plain name.
  useEffect(() => {
    document.title = documentTitle(board, APP_NAME);
  }, [board]);

  const visible = useMemo(
    () =>
      starredFirst(
        board.services.filter((service) => matchesFilters(service, filters, starred)),
        starred,
      ),
    [board.services, filters, starred],
  );

  // A screen reader hears what a filter or search left on the board once
  // the typing stops, not after every key and not on the first load.
  const [announcement, setAnnouncement] = useState("");
  const emptyMessage = emptyBoardMessage(filters, starred.size);
  const shownCount = useRef({ shown: visible.length, total: board.services.length, emptyMessage });
  useEffect(() => {
    shownCount.current = { shown: visible.length, total: board.services.length, emptyMessage };
  });
  const announcedFilters = useRef(filters);
  useEffect(() => {
    if (filters === announcedFilters.current) return;
    announcedFilters.current = filters;
    const timer = window.setTimeout(() => {
      const { shown, total, emptyMessage: why } = shownCount.current;
      setAnnouncement(resultsAnnouncement(shown, total, why));
    }, ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [filters]);

  // An attention chip whose card the filters hide clears them first, then
  // lands on the card once it has rendered. The pending jump is dropped as
  // soon as the filters move on or it has had its moment, so a card that
  // turns up later, with a refetch, never pulls the page to it unasked.
  const [revealing, setRevealing] = useState<{ id: ServiceId; filters: BoardFilters } | null>(null);
  function revealService(id: ServiceId, event: MouseEvent<HTMLAnchorElement>) {
    const service = board.services.find((candidate) => candidate.id === id);
    if (!service) return;
    const next = filtersToReveal(service, filters, starred);
    // On the board already: the plain anchor scrolls to it.
    if (!next) return;
    event.preventDefault();
    setRevealing({ id: service.id, filters: next });
    // Plainly, without a glide: a filter change has to feel instant (see
    // withCardMotion), and the cards' stagger already animates the board
    // that comes back.
    setFilters(next);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: `visible` is the trigger, not an input: the card to focus exists only once the cleared filters have rendered it.
  useEffect(() => {
    if (!revealing) return;
    if (filters !== revealing.filters) {
      setRevealing(null);
      return;
    }
    const card = document.getElementById(serviceAnchor(revealing.id));
    if (!card) return;
    setRevealing(null);
    card.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    card.focus({ preventScroll: true });
  }, [revealing, filters, visible]);
  useEffect(() => {
    if (!revealing) return;
    const timer = window.setTimeout(() => setRevealing(null), REVEAL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [revealing]);

  // "Issues" are what needs a look; a source that could not be read is not one (see matchesFilters).
  const issueCount = board.services.length - board.counts.operational - board.counts.unknown;
  // Starring moves a card, so it glides there like a refresh does.
  const onToggleStar = (id: ServiceSnapshot["id"]) => withCardMotion(() => toggleStar(id));
  const groups = groupServices(visible);
  // The board's most urgent service, from the whole board rather than the
  // filtered view (starred services first among equals, as on the cards).
  // It is highlighted only while it is also the first card on screen, so a
  // filter or search that hides it leaves no highlight rather than crowning
  // whatever is left.
  const mostUrgentId = useMemo(
    () =>
      groupServices(starredFirst(board.services, starred)).attention.find(
        (service) => service.health === "outage" || service.health === "degraded",
      )?.id,
    [board.services, starred],
  );
  const categoryCount = (id: "all" | CategoryId) =>
    id === "all" ? board.services.length : board.services.filter((service) => service.category === id).length;

  async function handleRefresh() {
    if (manualRefreshInFlight.current) return;
    manualRefreshInFlight.current = true;
    setRefreshing(true);
    try {
      // A slot refetch still in flight would land after the forced snapshot
      // and put the older one back on screen. The press asked for the newer
      // one, so any refetch running now, or started while this waits, is
      // cancelled before it can.
      await queryClient.cancelQueries({ queryKey: ["status-board"] });
      const next = await refreshStatusBoard();
      await queryClient.cancelQueries({ queryKey: ["status-board"] });
      withCardMotion(() => queryClient.setQueryData(["status-board"], next));
    } catch {
      await boardQuery.refetch();
    } finally {
      manualRefreshInFlight.current = false;
      setRefreshing(false);
    }
  }

  // Only after mount (`now` is 0 until then). Whether the query fetches on
  // mount depends on the clock: a browser whose clock runs ahead of the
  // server's finds the initial data stale and starts fetching during
  // hydration, and "Checking official sources" then replaced the server's
  // "Live" in the first client render, a hydration mismatch.
  const fetching = now > 0 && (boardQuery.isFetching || refreshing);
  // What stands where the groups would be while there are none; Recent changes follows it either way.
  const placeholder =
    fetching && !board.services.length ? (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: six identical placeholders that never reorder.
          <Skeleton key={index} className="h-56 rounded-lg" />
        ))}
      </div>
    ) : visible.length === 0 && !(starredOnly && !starsReady) ? (
      // Stars load after hydration; until then an empty Starred view proves nothing.
      // Not a live region: the results announcement already says this.
      <p className="surface px-5 py-10 text-center text-body text-muted">{emptyMessage}</p>
    ) : null;
  const freshness = useFreshness(board.generatedAt, fetching, now);

  useShortcuts(
    (action) => {
      switch (action.type) {
        case "focus-search":
          searchRef.current?.focus();
          searchRef.current?.select();
          return;
        case "leave-search":
          // First Escape clears the search, the next one leaves the field.
          if (query && document.activeElement === searchRef.current) updateFilters({ query: "" });
          else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          return;
        case "refresh":
          void handleRefresh();
          return;
        case "category":
          updateFilters({ category: action.category });
          return;
        case "toggle-issues":
          updateFilters({ issuesOnly: !issuesOnly });
          return;
        case "toggle-starred":
          updateFilters({ starredOnly: !starredOnly });
          return;
        case "reset":
          setFilters(DEFAULT_FILTERS);
          return;
        case "help":
          setSettingsOpen(true);
          return;
      }
    },
    { singleKey: singleKey.enabled },
  );

  return (
    <div className="liquid-stage text-fg">
      <div className="aurora" aria-hidden />
      <LensField />
      <div className="liquid-content">
        {/*
          First in the tab order, so a keyboard user can pass the header's
          controls. Focusing <main> in script keeps the address free of a
          #services fragment; without script the plain link still works.
        */}
        {/* biome-ignore lint/a11y/useValidAnchor: a real link, so the skip works without script; script only keeps #services out of the address. */}
        <a
          href="#services"
          onClick={(event) => {
            event.preventDefault();
            mainRef.current?.focus();
          }}
          className="focus-ring sr-only rounded-md bg-accent px-4 py-2 text-body font-medium text-bg focus:not-sr-only focus:fixed focus:top-[calc(env(safe-area-inset-top)+0.75rem)] focus:left-[calc(env(safe-area-inset-left)+0.75rem)] focus:z-50"
        >
          Skip to the board
        </a>
        <Hero
          generatedAt={board.generatedAt}
          verdict={verdict}
          onReveal={revealService}
          controls={
            // With the bar up, its copies are the ones in reach: Tab goes from them to the search field.
            <WhileBarUp store={dock}>
              {(barUp) => (
                <>
                  <AlertsButton skipTab={barUp} state={alerts.state} onToggle={alerts.toggle} />
                  <RefreshButton skipTab={barUp} fetching={fetching} onRefresh={() => void handleRefresh()} />
                </>
              )}
            </WhileBarUp>
          }
          live={
            <LiveBar
              freshness={freshness}
              now={now}
              refetchJitterMs={refetchJitter}
              checkedAt={checkedAt}
              // The dial is a Full-background flourish; the words say the same.
              dial={
                background.value === "full" ? (
                  <PeriodDial now={now} jitterMs={refetchJitter} tone={verdict.tone} className="size-6 shrink-0" />
                ) : null
              }
            />
          }
        >
          <p role="status" className="sr-only">
            {announcement}
          </p>
        </Hero>
        <div
          ref={bodyRef}
          className="board-body page-gutter relative mx-auto flex max-w-[62rem] flex-wrap content-start items-start gap-x-4 lg:gap-x-8"
        >
          {/* Right before the search field in the markup, so Tab goes from the bar's buttons to it. */}
          <CompactHeader
            store={dock}
            barRef={barRef}
            slotRef={slotRef}
            verdict={verdict}
            live={freshness.state}
            checkedAt={checkedAt}
            nextIn={nextInText(now, refetchJitter)}
          >
            <AlertsButton state={alerts.state} onToggle={alerts.toggle} />
            <RefreshButton fetching={fetching} onRefresh={() => void handleRefresh()} />
          </CompactHeader>
          {/* biome-ignore lint/a11y/useSemanticElements: <search> is Safari 17+; role="search" on a div names the same landmark everywhere. */}
          <div ref={dockRef} role="search" className="search-dock basis-full lg:flex-none lg:basis-[var(--margin-col)]">
            <SearchField
              store={dock}
              dockRef={dockRef}
              inputRef={searchRef}
              query={query}
              onQuery={(next) => updateFilters({ query: next })}
              showSlash={singleKey.enabled}
            />
          </div>
          {/* The row's landmark, and its flex item. The segments scroll sideways on a phone; the two toggles follow them. */}
          <section
            ref={chipsRef}
            aria-label="Filter services"
            className="board-chips mt-3 flex min-w-0 basis-full flex-wrap items-center gap-2 lg:mt-0 lg:flex-1 lg:basis-0 lg:self-center"
          >
            <FilterBar
              filters={filters}
              onChange={updateFilters}
              categoryCount={categoryCount}
              issueCount={issueCount}
              starredCount={starred.size}
            />
          </section>

          {/* tabIndex -1: the skip link can move focus here; Tab never stops on it. */}
          <main ref={mainRef} id="services" tabIndex={-1} className="relative mt-6 basis-full outline-none">
            {boardQuery.isError ? (
              <p role="alert" className="surface mb-4 px-4 py-3 text-body text-down">
                Could not refresh official sources. Showing the last successful snapshot.
              </p>
            ) : null}

            <div className="min-w-0">
              <BoardSections
                groups={groups}
                mostUrgentId={mostUrgentId}
                changedIds={changedIds}
                starred={starred}
                onToggleStar={onToggleStar}
                now={now}
                feed={feed}
                placeholder={placeholder}
              />
            </div>
          </main>
          {/* Clear of the home indicator and Safari's bottom toolbar on an iPhone. */}
          <SiteFooter
            className="mt-14 basis-full pb-[calc(5rem+env(safe-area-inset-bottom))]"
            onOpenSettings={() => setSettingsOpen(true)}
            singleKey={singleKey.enabled}
          />
          <SettingsDialog
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            singleKey={singleKey.enabled}
            onSingleKeyChange={singleKey.setEnabled}
            reduceGlass={reduceGlass.enabled}
            onReduceGlassChange={reduceGlass.setEnabled}
            background={{ value: background.value, onChange: background.setValue }}
            tilt={{
              supported: tilt.supported,
              enabled: tilt.enabled,
              status: tilt.status,
              onChange: tilt.setEnabled,
            }}
          />
        </div>
      </div>
    </div>
  );
}
