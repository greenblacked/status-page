import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Bell, BellOff, BellRing, RefreshCw, Search, Star, X } from "lucide-react";
import {
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { CompactHeader, useDockState, useSearchDock } from "@/components/status/compact-header";
import { prefersReducedMotion, useCountUp, useSpotlight, withCardMotion } from "@/components/status/effects";
import { HealthDot } from "@/components/status/health-dot";
import { LensField } from "@/components/status/lens-field";
import { LiveBar, useFreshness } from "@/components/status/live-bar";
import { LiveSignal } from "@/components/status/live-signal";
import { LocalTime } from "@/components/status/local-time";
import { PeriodDial } from "@/components/status/period-dial";
import { ServiceCard } from "@/components/status/service-card";
import { SettingsDialog } from "@/components/status/settings-dialog";
import { UpdateFeed } from "@/components/status/update-feed";
import { type AlertsState, useBoardAlerts } from "@/components/status/use-alerts";
import { useBackground } from "@/components/status/use-background";
import { useNow } from "@/components/status/use-now";
import { useReduceGlass } from "@/components/status/use-reduce-glass";
import { useShortcuts, useSingleKeyShortcuts } from "@/components/status/use-shortcuts";
import { useStarred } from "@/components/status/use-starred";
import { useTiltLighting } from "@/components/status/use-tilt-lighting";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchStatusBoard, refreshStatusBoard } from "@/lib/status/board";
import { APP_NAME, CATEGORIES } from "@/lib/status/catalog";
import { createDockStore, type DockStore } from "@/lib/status/dock";
import {
  type BoardFilters,
  DEFAULT_FILTERS,
  emptyBoardMessage,
  filtersToReveal,
  matchesFilters,
  resultsAnnouncement,
} from "@/lib/status/filters";
import { attentionBreakdown } from "@/lib/status/health";
import { boardHeadline, documentTitle, groupServices, serviceAnchor } from "@/lib/status/layout";
import { canvasFont, placeholderFits } from "@/lib/status/placeholder";
import { emptyPulseStore, loadPulseStore, type PulseStore, savePulseStore, syncPulse } from "@/lib/status/pulse";
import {
  CACHE_TTL_MS,
  everyInterval,
  type Freshness,
  lastPulseAt,
  nextRefetchAt,
  PULSE_INTERVAL_MS,
  parseTimestamp,
  pickRefetchJitter,
  spokenDuration,
} from "@/lib/status/schedule";
import { starredFirst } from "@/lib/status/starred";
import type { BoardSnapshot, CategoryId, ServiceId, ServiceSnapshot } from "@/lib/status/types";
import { cn } from "@/lib/utils";

const FILTERS: Array<{ id: "all" | CategoryId; label: string }> = [{ id: "all", label: "All" }, ...CATEGORIES];

/**
 * One string, so server rendering emits one text node. Interpolated JSX children would come out as
 * "checks <!-- -->every two minutes<!-- -->; ...", which breaks any text match on the served HTML
 * (scripts/ci/smoke.sh matches this sentence).
 */
const CADENCE_NOTE = `This page checks ${everyInterval(PULSE_INTERVAL_MS)}; the server reads the official vendor feeds and keeps them for ${spokenDuration(CACHE_TTL_MS)}.`;

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
  const { query, category, issuesOnly, starredOnly } = filters;
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
  useSpotlight(mainRef);
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
  const headline = boardHeadline(board);
  const alerts = useBoardAlerts(board);
  const { starred, ready: starsReady, toggle: toggleStar } = useStarred();
  const pulseStore = store ?? emptyPulseStore();
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
  function revealService(service: ServiceSnapshot, event: MouseEvent<HTMLAnchorElement>) {
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

  const issueCount = board.services.length - board.counts.operational;
  // Starring moves a card, so it glides there like a refresh does.
  const onToggleStar = (id: ServiceSnapshot["id"]) => withCardMotion(() => toggleStar(id));
  const groups = groupServices(visible);
  // The board's most urgent service, from the whole board rather than the
  // filtered view (starred services first among equals, as on the cards).
  // It is highlighted only while it is also the first card on screen, so a
  // filter or search that hides it leaves no highlight rather than crowning
  // whatever is left.
  const mostUrgentId = useMemo(
    () => groupServices(starredFirst(board.services, starred)).attention[0]?.id,
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
      <div className="aurora-grid" aria-hidden />
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
          className="focus-ring sr-only rounded-full bg-accent px-4 py-2 text-sm font-medium text-bg focus:not-sr-only focus:fixed focus:top-[calc(env(safe-area-inset-top)+0.75rem)] focus:left-[calc(env(safe-area-inset-left)+0.75rem)] focus:z-50"
        >
          Skip to services
        </a>
        <header className="page-gutter relative mx-auto flex max-w-6xl flex-col gap-6 pt-8 pb-3 sm:pt-12">
          {/* Wraps, so at a large text size the buttons drop under the text instead of squeezing it to a word a line. */}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="hero-recede min-w-[min(10rem,100%)] flex-1">
              <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.22em] text-subtle">
                <LiveSignal state={freshness.state} />
                Live status board
              </p>
              <h1 className="mt-2 font-display text-4xl tracking-[-0.035em] text-balance [font-optical-sizing:auto] [font-weight:350] sm:text-6xl">
                {APP_NAME}
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted text-pretty sm:text-base">
                Official vendor status for {board.services.length} services, checked {everyInterval(PULSE_INTERVAL_MS)}.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* With the bar up, its copies are the ones in reach: Tab goes from them to the search field. */}
              <WhileBarUp store={dock}>
                {(barUp) => (
                  <>
                    <AlertsButton skipTab={barUp} state={alerts.state} onToggle={alerts.toggle} />
                    <RefreshButton skipTab={barUp} fetching={fetching} onRefresh={() => void handleRefresh()} />
                  </>
                )}
              </WhileBarUp>
            </div>
          </div>

          <SummaryPanel
            board={board}
            headline={headline}
            fetching={fetching}
            freshness={freshness}
            now={now}
            refetchJitter={refetchJitter}
            onReveal={revealService}
          />

          <p role="status" className="sr-only">
            {announcement}
          </p>
        </header>
        <div
          ref={bodyRef}
          className="board-body page-gutter relative mx-auto flex max-w-6xl flex-wrap content-start items-start gap-x-4"
        >
          {/* Right before the search field in the markup, so Tab goes from the bar's buttons to it. */}
          <CompactHeader
            store={dock}
            barRef={barRef}
            slotRef={slotRef}
            name={APP_NAME}
            live={freshness.state}
            headline={headline}
          >
            <AlertsButton bar state={alerts.state} onToggle={alerts.toggle} />
            <RefreshButton bar fetching={fetching} onRefresh={() => void handleRefresh()} />
          </CompactHeader>
          {/* biome-ignore lint/a11y/useSemanticElements: <search> is Safari 17+; role="search" on a div names the same landmark everywhere. */}
          <div ref={dockRef} role="search" className="search-dock basis-full lg:flex-1 lg:basis-0">
            <div className="search-field">
              <label className="relative block min-w-0 flex-1">
                <span className="sr-only">Search services</span>
                <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-subtle" />
                <SearchInput
                  ref={searchRef}
                  store={dock}
                  dockRef={dockRef}
                  value={query}
                  onChange={(event) => updateFilters({ query: event.target.value })}
                  type="search"
                  enterKeyHint="search"
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  className={cn("appearance-none pl-10", query ? "pr-11" : "sm:pr-10")}
                />
                {singleKey.enabled && !query ? (
                  <kbd
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 right-3.5 hidden -translate-y-1/2 rounded-2xs glass-inset px-1.5 font-mono text-[11px] text-subtle sm:block"
                  >
                    /
                  </kbd>
                ) : null}
              </label>
              {/* Ours, not the browser's: a 44pt target that keeps the field focused (and the keyboard up on a phone). */}
              {query ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  className="focus-ring pressable absolute top-0 right-0 flex size-11 items-center justify-center rounded-full text-subtle hover:text-fg"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    updateFilters({ query: "" });
                    searchRef.current?.focus();
                  }}
                >
                  <X className="size-4" aria-hidden />
                </button>
              ) : null}
            </div>
          </div>
          {/* One scrolling row on phones instead of three wrapped ones. */}
          {/* The row's landmark, and its flex item: the group inside bleeds to the screen edges on a phone. */}
          <section
            ref={chipsRef}
            aria-label="Filters"
            className="board-chips mt-3 min-w-0 basis-full lg:mt-0 lg:basis-auto lg:self-center"
          >
            {/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> cannot be this scrolling flex row in every browser; role="group" gives it the same name and grouping. */}
            <div
              className="page-bleed flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&::-webkit-scrollbar]:hidden"
              role="group"
              aria-label="Filter services"
            >
              {FILTERS.map((filter) => (
                <Button
                  key={filter.id}
                  variant={category === filter.id ? "default" : "outline"}
                  size="sm"
                  className="shrink-0"
                  aria-pressed={category === filter.id}
                  onClick={() => updateFilters({ category: filter.id })}
                >
                  {filter.label}
                  <span className="font-mono text-[11px] tabular-nums opacity-70">{categoryCount(filter.id)}</span>
                </Button>
              ))}
              <Button
                variant={issuesOnly ? "default" : "outline"}
                size="sm"
                className="shrink-0"
                aria-pressed={issuesOnly}
                onClick={() => updateFilters({ issuesOnly: !issuesOnly })}
              >
                Issues only
                <span className="font-mono text-[11px] tabular-nums opacity-70">{issueCount}</span>
              </Button>
              <Button
                variant={starredOnly ? "default" : "outline"}
                size="sm"
                className="shrink-0"
                aria-pressed={starredOnly}
                onClick={() => updateFilters({ starredOnly: !starredOnly })}
              >
                <Star className={cn("size-3.5", starredOnly && "fill-current")} />
                Starred
                <span className="font-mono text-[11px] tabular-nums opacity-70">{starred.size}</span>
              </Button>
            </div>
          </section>

          {/* tabIndex -1: the skip link can move focus here; Tab never stops on it. */}
          <main ref={mainRef} id="services" tabIndex={-1} className="relative mt-3 basis-full pt-2 outline-none">
            {boardQuery.isError ? (
              <p role="alert" className="mb-4 rounded-md glass px-4 py-3 text-sm text-down">
                Could not refresh official sources. Showing the last successful snapshot.
              </p>
            ) : null}

            <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="flex min-w-0 flex-col gap-8">
                {fetching && !board.services.length ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {Array.from({ length: 6 }).map((_, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: six identical placeholders that never reorder.
                      <Skeleton key={index} className="h-56 rounded-lg" />
                    ))}
                  </div>
                ) : visible.length === 0 ? (
                  // Stars load after hydration; until then an empty Starred view proves nothing.
                  // Not a live region: the results announcement already says this.
                  starredOnly && !starsReady ? null : (
                    // The board's one serif phrase: a caption for the quiet, not a UI label.
                    <p className="rounded-lg glass px-5 py-10 text-center font-serif text-lg text-muted italic">
                      {emptyMessage}
                    </p>
                  )
                ) : (
                  <>
                    <ServiceSection id="attention" title="Needs attention" services={groups.attention}>
                      {/* items-start: a short card keeps its own height instead of stretching to its row's tallest. */}
                      <div className="grid grid-cols-1 items-start gap-3 @xl:grid-cols-2">
                        {groups.attention.map((service, index) => (
                          // One element type at every position, so a card that moves in or out of
                          // first place is moved, not remounted: keyboard focus stays on its Star
                          // button and the fade-in does not replay.
                          <ServiceCard
                            key={service.id}
                            service={service}
                            index={index}
                            highlight={index === 0 && service.id === mostUrgentId}
                            emphasized={changedIds.has(service.id)}
                            starred={starred.has(service.id)}
                            onToggleStar={onToggleStar}
                            now={now}
                          />
                        ))}
                      </div>
                    </ServiceSection>
                    <ServiceSection id="operational" title="Operational" services={groups.operational}>
                      {/* The full card, healthy or not, in the attention grid's columns. */}
                      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                        {groups.operational.map((service, index) => (
                          <ServiceCard
                            key={service.id}
                            service={service}
                            index={index}
                            emphasized={changedIds.has(service.id)}
                            starred={starred.has(service.id)}
                            onToggleStar={onToggleStar}
                            now={now}
                          />
                        ))}
                      </div>
                    </ServiceSection>
                    <ServiceSection id="releases" title="Releases" services={groups.releases}>
                      <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
                        {groups.releases.map((service, index) => (
                          <ServiceCard
                            key={service.id}
                            service={service}
                            index={index}
                            emphasized={changedIds.has(service.id)}
                            starred={starred.has(service.id)}
                            onToggleStar={onToggleStar}
                            now={now}
                          />
                        ))}
                      </div>
                    </ServiceSection>
                  </>
                )}
              </div>
              {/* Pinned beside the cards on wide screens instead of stretching to their height. */}
              <UpdateFeed pulses={pulseStore.pulses} className="board-log-pin" />
            </div>
          </main>
          {/* Clear of the home indicator and Safari's bottom toolbar on an iPhone. */}
          <footer className="mt-14 flex basis-full flex-col gap-2 pb-[calc(5rem+env(safe-area-inset-bottom))] text-sm text-subtle">
            <p>
              Status Page reads vendor status feeds only. It is not affiliated with Google, Amazon, Valve, Epic,
              Spotify, Apple, MikroTik, xAI, OpenAI, or Anthropic.
            </p>
            <p>{CADENCE_NOTE}</p>
            <p>
              <a
                className="focus-ring pressable touch-target inline-block rounded-2xs underline decoration-border underline-offset-4 hover:text-fg"
                href="https://github.com/greenblacked/status-page"
                target="_blank"
                rel="noopener noreferrer"
              >
                Source on GitHub
                <ArrowUpRight aria-hidden="true" className="ml-0.5 inline size-3.5 align-[-2px]" />
              </a>
              {" · "}
              <a
                className="focus-ring pressable touch-target inline-block rounded-2xs underline decoration-border underline-offset-4 hover:text-fg"
                href="https://github.com/greenblacked/status-page/blob/main/LICENSE"
                target="_blank"
                rel="noopener noreferrer license"
              >
                MIT License
                <ArrowUpRight aria-hidden="true" className="ml-0.5 inline size-3.5 align-[-2px]" />
              </a>
              : free to use, copy, modify and share, with the copyright notice kept.
            </p>
            <p>
              Use the board elsewhere:{" "}
              <a
                className="focus-ring pressable touch-target inline-block rounded-2xs underline decoration-border underline-offset-4 hover:text-fg"
                href="/api/status.json"
              >
                JSON API
              </a>
              {" · "}
              <a
                className="focus-ring pressable touch-target inline-block rounded-2xs underline decoration-border underline-offset-4 hover:text-fg"
                href="/feed.xml"
              >
                Atom feed
              </a>{" "}
              for Slack, Teams and feed readers ·{" "}
              <a
                className="focus-ring pressable touch-target inline-block rounded-2xs underline decoration-border underline-offset-4 hover:text-fg"
                href="/api/badge/board"
              >
                status badges
              </a>
              .
            </p>
            {/*
              On every screen width: with the single-key shortcuts off, ? no
              longer opens the list, and this button is the way back to the
              switches, including on a desktop zoomed to a phone's width, and
              the only way to them on a touch screen.
            */}
            <p>
              <button
                type="button"
                className="focus-ring pressable touch-target rounded-2xs underline decoration-border underline-offset-4 hover:text-fg"
                onClick={() => setSettingsOpen(true)}
              >
                Settings and shortcuts
              </button>
              {singleKey.enabled ? (
                <span className="hidden sm:inline">
                  {" "}
                  (press <kbd className="rounded-2xs glass-inset px-1.5 font-mono text-[11px] text-muted">?</kbd>)
                </span>
              ) : null}
            </p>
          </footer>
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

function ServiceSection({
  id,
  title,
  services,
  children,
}: {
  id: string;
  title: string;
  services: ServiceSnapshot[];
  children: ReactNode;
}) {
  if (services.length === 0) return null;
  return (
    <section aria-labelledby={`${id}-heading`}>
      <h2
        id={`${id}-heading`}
        className="mb-3 flex items-baseline gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-subtle"
      >
        {title}
        <span className="tabular-nums text-muted">{services.length}</span>
      </h2>
      {/* A size container: the grid inside, and each card in it, lay out by their own width. */}
      <div className="@container">{children}</div>
    </section>
  );
}

function SummaryPanel({
  board,
  headline,
  fetching,
  freshness,
  now,
  refetchJitter,
  onReveal,
}: {
  board: BoardSnapshot;
  headline: ReturnType<typeof boardHeadline>;
  fetching: boolean;
  freshness: Freshness;
  now: number;
  refetchJitter: number;
  /** A chip was followed; clears the filters first if they hide its card. */
  onReveal: (service: ServiceSnapshot, event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const total = board.services.length;
  const attention = total - board.counts.operational;
  const affected = groupServices(board.services).attention;
  const generatedAt = parseTimestamp(board.generatedAt);

  return (
    <section aria-labelledby="board-headline" className="glass rounded-xl p-5 sm:p-6">
      {/* A size container: below lg, whether the counts fit beside the dial is a question of this row's width in rem, so a large text size stacks them. */}
      <div className="@container flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h2
            id="board-headline"
            className="flex items-center gap-3 font-display text-2xl font-medium tracking-[-0.03em] text-balance sm:text-3xl"
          >
            <HealthDot
              health={headline.tone}
              ping={headline.tone !== "operational"}
              pingColor="event"
              className="size-2.5"
            />
            {/* Live on the sentence alone: the counts below roll as they change. */}
            <span aria-live="polite">{headline.title}</span>
          </h2>
          <p className="mt-1.5 font-mono text-[11px] tabular-nums text-subtle">
            {attention ? attentionBreakdown(board.counts) : `All ${total} official sources report normal operation`}
            {/* UTC on the server and while hydrating, the viewer's own zone after (LocalTime). */}
            {generatedAt === null ? null : (
              <>
                {" · as of "}
                <LocalTime at={generatedAt} />
              </>
            )}
          </p>
          {affected.length ? (
            <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="Services that need attention">
              {affected.map((service) => (
                <li key={service.id}>
                  <a
                    href={`#${serviceAnchor(service.id)}`}
                    onClick={(event) => onReveal(service, event)}
                    className="focus-ring pressable inline-flex min-h-8 items-center gap-1.5 rounded-full glass-inset pointer-coarse:min-h-11 px-3 text-xs text-muted hover:text-fg"
                  >
                    <HealthDot health={service.health} />
                    {service.name}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {/* On a phone the counts stack into a specimen table beside the dial; wider, they sit in a row. */}
        <div className="flex flex-col gap-5 @min-[15rem]:flex-row @min-[15rem]:items-center @min-[15rem]:max-lg:justify-between sm:gap-10 lg:shrink-0 lg:justify-end">
          <dl className="flex min-w-0 flex-col gap-1.5 @min-[15rem]:max-sm:flex-1 sm:grid sm:flex-none sm:grid-cols-3 sm:gap-10">
            <Stat label="Operational" value={board.counts.operational} of={total} />
            <Stat label="Attention" value={attention} />
            <Stat label="Sources" value={total - board.counts.unknown} of={total} />
          </dl>
          <PeriodDial
            now={now}
            jitterMs={refetchJitter}
            tone={headline.tone}
            className="mx-auto size-[80px] min-[380px]:size-[96px] @min-[15rem]:mx-0 sm:size-[112px] lg:size-[128px]"
          />
        </div>
      </div>
      <LiveBar
        freshness={freshness}
        isFetching={fetching}
        now={now}
        refetchJitterMs={refetchJitter}
        className="mt-5 border-t border-border pt-4"
      />
    </section>
  );
}

function Stat({ label, value, of }: { label: string; value: number; of?: number }) {
  const shown = useCountUp(value);
  return (
    <div className="flex items-baseline justify-between gap-2 sm:block">
      <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-subtle">{label}</dt>
      <dd className="font-display text-lg tabular-nums tracking-[-0.03em] sm:mt-1 sm:text-2xl">
        {shown}
        {of !== undefined ? <span className="text-subtle">/{of}</span> : null}
      </dd>
    </div>
  );
}

const ALERT_LABEL: Record<AlertsState, string> = {
  unsupported: "Alerts are not supported in this browser",
  off: "Get a browser alert when a service changes",
  on: "Browser alerts are on; click to turn them off",
  blocked: "Alerts are blocked in this browser's site settings",
};

/**
 * Hands its children whether the floating bar is up. It is the one part of the
 * hero that renders when that changes, so the board does not.
 */
function WhileBarUp({ store, children }: { store: DockStore; children: (barUp: boolean) => ReactNode }) {
  return children(useDockState(store).barShown);
}

const LONG_PLACEHOLDER = "Search GCP, CS2 Europe, RouterOS…";
const SHORT_PLACEHOLDER = "Search…";

/**
 * Whether `text` fits the field as a placeholder, unclipped. The field at rest
 * is as wide as its dock (`dockRef`, which the merge into the bar never
 * resizes), so this measures the text against that width less the input's own
 * padding, and again when either changes. True until measured, which is what
 * the server rendered, so hydration sees the same placeholder.
 */
function usePlaceholderFits(text: string, dockRef: RefObject<HTMLElement | null>): boolean {
  const [fits, setFits] = useState(true);
  useEffect(() => {
    const dock = dockRef.current;
    const input = dock?.querySelector("input");
    const canvas = document.createElement("canvas").getContext("2d");
    if (!dock || !input || !canvas) return;
    const measure = () => {
      const style = getComputedStyle(input);
      canvas.font = canvasFont(style);
      setFits(placeholderFits(dock.clientWidth, canvas.measureText(text).width, style));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    // The system font can arrive after the first measure.
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [text, dockRef]);
  return fits;
}

/**
 * The search field's input. Its placeholder is the long one in the hero and the
 * short one once the field is fully in the bar, and changes only there (never
 * while the field is part way), in this component rather than the board's. The
 * short one also stands in wherever the field, at rest, is too narrow to show
 * the long one whole (a small phone, or beside the chips just past 1024px).
 */
function SearchInput({
  store,
  dockRef,
  ...props
}: { store: DockStore; dockRef: RefObject<HTMLElement | null> } & ComponentProps<typeof Input>) {
  const { docked } = useDockState(store);
  const fits = usePlaceholderFits(LONG_PLACEHOLDER, dockRef);
  return <Input placeholder={docked || !fits ? SHORT_PLACEHOLDER : LONG_PLACEHOLDER} {...props} />;
}

/**
 * Rendered twice, in the hero and in the compact header, both driven by
 * the board's one handleRefresh. It carries no id, so the copies never
 * collide. The bar's copy (`bar`) is a full 44pt touch target; the hero's leaves the Tab order while the bar is up (`skipTab`).
 */
function RefreshButton({
  bar,
  skipTab,
  fetching,
  onRefresh,
}: {
  bar?: boolean;
  skipTab?: boolean;
  fetching: boolean;
  onRefresh: () => void;
}) {
  return (
    <Button
      variant="outline"
      size={bar ? "default" : "sm"}
      className={cn("shrink-0", bar && "max-sm:w-11 max-sm:px-0")}
      tabIndex={skipTab ? -1 : undefined}
      onClick={onRefresh}
      // Not `disabled`: every background refetch would drop keyboard
      // focus to <body>. handleRefresh ignores a press while its own
      // refresh is in flight, cancels a background one, and aria-busy
      // says a check is running.
      aria-busy={fetching}
      aria-label="Refresh status now"
    >
      <RefreshCw className={cn("size-3.5", fetching && "motion-safe:animate-spin")} />
      <span className="hidden sm:inline">Refresh</span>
    </Button>
  );
}

function AlertsButton({
  bar,
  skipTab,
  state,
  onToggle,
}: {
  bar?: boolean;
  skipTab?: boolean;
  state: AlertsState;
  onToggle: () => void;
}) {
  // Two copies render, one in the compact header, so the hint's id is per copy.
  const hintId = useId();
  if (state === "unsupported") return null;
  const Icon = state === "on" ? BellRing : state === "blocked" ? BellOff : Bell;
  const blocked = state === "blocked";
  return (
    <>
      <Button
        variant={state === "on" ? "default" : "outline"}
        size={bar ? "default" : "sm"}
        className={cn(bar && "max-sm:w-11 max-sm:px-0")}
        tabIndex={skipTab ? -1 : undefined}
        // aria-disabled, not disabled: a disabled button drops out of the Tab
        // order, so a keyboard or screen reader user never learns why alerts
        // are off. This one stays reachable, does nothing, and says why.
        onClick={blocked ? undefined : onToggle}
        aria-disabled={blocked || undefined}
        aria-describedby={blocked ? hintId : undefined}
        // A toggle keeps one name and lets aria-pressed carry the state; the
        // title explains the current state to pointer users.
        aria-pressed={state === "on"}
        aria-label="Browser alerts"
        data-alerts-toggle
        title={ALERT_LABEL[state]}
      >
        <Icon className="size-3.5" />
        <span className="hidden sm:inline">Alerts</span>
      </Button>
      {blocked ? (
        <span id={hintId} className="sr-only">
          Blocked in this browser's site settings
        </span>
      ) : null}
    </>
  );
}
