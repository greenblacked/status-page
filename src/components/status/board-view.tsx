import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, BellRing, RefreshCw, Search, Star } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { CompactHeader, useScrolledPast } from "@/components/status/compact-header";
import { prefersReducedMotion, useCountUp, useSpotlight, withViewTransition } from "@/components/status/effects";
import { HealthDot } from "@/components/status/health-dot";
import { type Freshness, LiveBar, useFreshness } from "@/components/status/live-bar";
import { LiveSignal } from "@/components/status/live-signal";
import { ServiceCard, ServiceTile } from "@/components/status/service-card";
import { ShortcutsDialog } from "@/components/status/shortcuts-dialog";
import { UpdateFeed } from "@/components/status/update-feed";
import { type AlertsState, useBoardAlerts } from "@/components/status/use-alerts";
import { useNow } from "@/components/status/use-now";
import { useShortcuts, useSingleKeyShortcuts } from "@/components/status/use-shortcuts";
import { useStarred } from "@/components/status/use-starred";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchStatusBoard, refreshStatusBoard } from "@/lib/status/board";
import { APP_NAME, CATEGORIES } from "@/lib/status/catalog";
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
import { emptyPulseStore, loadPulseStore, type PulseStore, savePulseStore, syncPulse } from "@/lib/status/pulse";
import {
  CACHE_TTL_MS,
  formatUtcTime,
  lastPulseAt,
  nextRefetchAt,
  parseTimestamp,
  pickRefetchJitter,
} from "@/lib/status/schedule";
import { starredFirst } from "@/lib/status/starred";
import type { BoardSnapshot, CategoryId, ServiceId, ServiceSnapshot } from "@/lib/status/types";
import { cn } from "@/lib/utils";

const FILTERS: Array<{ id: "all" | CategoryId; label: string }> = [{ id: "all", label: "All" }, ...CATEGORIES];

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
  const heroRef = useRef<HTMLDivElement>(null);
  const heroGone = useScrolledPast(heroRef);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const singleKey = useSingleKeyShortcuts();
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
    // Plainly, not in a View Transition: a filter change has to feel
    // instant (see withViewTransition), and the cards' stagger already
    // animates the board that comes back.
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
  const onToggleStar = (id: ServiceSnapshot["id"]) => withViewTransition(() => toggleStar(id));
  const groups = groupServices(visible);
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
      withViewTransition(() => queryClient.setQueryData(["status-board"], next));
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
          setShortcutsOpen(true);
          return;
      }
    },
    { singleKey: singleKey.enabled },
  );

  return (
    <div className="liquid-stage text-fg">
      <div className="aurora" aria-hidden />
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
        <CompactHeader shown={heroGone} name={APP_NAME} live={freshness.state} headline={headline}>
          <AlertsButton state={alerts.state} onToggle={alerts.toggle} />
          <RefreshButton fetching={fetching} onRefresh={() => void handleRefresh()} />
        </CompactHeader>
        <header className="page-gutter relative mx-auto flex max-w-6xl flex-col gap-6 pt-8 pb-4 sm:pt-12">
          <div ref={heroRef} className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.22em] text-subtle">
                <LiveSignal state={freshness.state} />
                Live status board
              </p>
              <h1 className="mt-2 font-display text-4xl font-medium tracking-[-0.04em] text-balance sm:text-6xl">
                {APP_NAME}
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted text-pretty sm:text-base">
                Official vendor status for {board.services.length} services, checked every two minutes.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <AlertsButton state={alerts.state} onToggle={alerts.toggle} />
              <RefreshButton fetching={fetching} onRefresh={() => void handleRefresh()} />
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

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <label className="relative block min-w-0 flex-1">
              <span className="sr-only">Search services</span>
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-subtle" />
              <Input
                ref={searchRef}
                value={query}
                onChange={(event) => updateFilters({ query: event.target.value })}
                placeholder="Search GCP, CS2 Europe, RouterOS…"
                className="pl-10 sm:pr-10"
              />
              {singleKey.enabled ? (
                <kbd
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 right-3.5 hidden -translate-y-1/2 rounded-2xs glass-inset px-1.5 font-mono text-[11px] text-subtle sm:block"
                >
                  /
                </kbd>
              ) : null}
            </label>
            {/* One scrolling row on phones instead of three wrapped ones. */}
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
          </div>
          <p role="status" className="sr-only">
            {announcement}
          </p>
        </header>

        {/* tabIndex -1: the skip link can move focus here; Tab never stops on it. */}
        <main
          ref={mainRef}
          id="services"
          tabIndex={-1}
          className="page-gutter relative mx-auto max-w-6xl scroll-mt-4 pb-20 outline-none"
        >
          {boardQuery.isError ? (
            <p role="alert" className="mb-4 rounded-md glass px-4 py-3 text-sm text-down">
              Could not refresh official sources. Showing the last successful snapshot.
            </p>
          ) : null}

          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
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
                  <p className="rounded-lg glass px-5 py-10 text-center text-muted">{emptyMessage}</p>
                )
              ) : (
                <>
                  <ServiceSection id="attention" title="Needs attention" services={groups.attention}>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {groups.attention.map((service, index) => (
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
                  <ServiceSection id="operational" title="Operational" services={groups.operational}>
                    {/* Two columns once the board log takes the right side: three left each name a few letters. */}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-2">
                      {groups.operational.map((service, index) => (
                        <ServiceTile
                          key={service.id}
                          service={service}
                          index={index}
                          emphasized={changedIds.has(service.id)}
                          starred={starred.has(service.id)}
                          onToggleStar={onToggleStar}
                        />
                      ))}
                    </div>
                  </ServiceSection>
                  <ServiceSection id="releases" title="Releases" services={groups.releases}>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            <UpdateFeed pulses={pulseStore.pulses} className="xl:sticky xl:top-6" />
          </div>

          {/* Clear of the home indicator and Safari's bottom toolbar on an iPhone. */}
          <footer className="mt-14 flex flex-col gap-2 pb-[env(safe-area-inset-bottom)] text-sm text-subtle">
            <p>
              Status Bar reads vendor status feeds only. It is not affiliated with Google, Amazon, Valve, Epic, Spotify,
              Apple, MikroTik, xAI, OpenAI, or Anthropic.
            </p>
            <p>Cached server snapshots update every two minutes from official vendor feeds.</p>
            <p>
              Use the board elsewhere:{" "}
              <a
                className="focus-ring pressable rounded-2xs underline decoration-border underline-offset-4 hover:text-fg"
                href="/api/status.json"
              >
                JSON API
              </a>
              {" · "}
              <a
                className="focus-ring pressable rounded-2xs underline decoration-border underline-offset-4 hover:text-fg"
                href="/feed.xml"
              >
                Atom feed
              </a>{" "}
              for Slack, Teams and feed readers ·{" "}
              <a
                className="focus-ring pressable rounded-2xs underline decoration-border underline-offset-4 hover:text-fg"
                href="/api/badge/board"
              >
                status badges
              </a>
              .
            </p>
            {/*
              On every screen width: with the single-key shortcuts off, ? no
              longer opens the list, and this button is the way back to the
              switch, including on a desktop zoomed to a phone's width.
            */}
            <p>
              <button
                type="button"
                className="focus-ring pressable rounded-2xs underline decoration-border underline-offset-4 hover:text-fg"
                onClick={() => setShortcutsOpen(true)}
              >
                Keyboard shortcuts
              </button>
              {singleKey.enabled ? (
                <span className="hidden sm:inline">
                  {" "}
                  (press <kbd className="rounded-2xs glass-inset px-1.5 font-mono text-[11px] text-muted">?</kbd>)
                </span>
              ) : null}
            </p>
          </footer>
          <ShortcutsDialog
            open={shortcutsOpen}
            onClose={() => setShortcutsOpen(false)}
            singleKey={singleKey.enabled}
            onSingleKeyChange={singleKey.setEnabled}
          />
        </main>
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
      {children}
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
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h2
            id="board-headline"
            className="flex items-center gap-3 font-display text-2xl font-medium tracking-[-0.03em] text-balance sm:text-3xl"
          >
            <HealthDot health={headline.tone} ping={headline.tone !== "operational"} className="size-2.5" />
            {/* Live on the sentence alone: the counts below roll as they change. */}
            <span aria-live="polite">{headline.title}</span>
          </h2>
          <p className="mt-1.5 font-mono text-[11px] tabular-nums text-subtle">
            {attention ? attentionBreakdown(board.counts) : `All ${total} official sources report normal operation`}
            {/* UTC, so the server and the browser agree on the text. */}
            {generatedAt === null ? null : (
              <>
                {" · as of "}
                <time dateTime={board.generatedAt}>{formatUtcTime(generatedAt)}</time>
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
                    className="focus-ring pressable inline-flex min-h-8 items-center gap-1.5 rounded-full glass-inset px-3 text-xs text-muted hover:text-fg"
                  >
                    <HealthDot health={service.health} />
                    {service.name}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <dl className="grid shrink-0 grid-cols-3 gap-6 sm:gap-10">
          <Stat label="Operational" value={board.counts.operational} of={total} />
          <Stat label="Attention" value={attention} />
          <Stat label="Sources" value={total - board.counts.unknown} of={total} />
        </dl>
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
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-subtle">{label}</dt>
      <dd className="mt-1 font-display text-2xl tabular-nums tracking-[-0.03em]">
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
 * Rendered twice, in the hero and in the compact header, both driven by
 * the board's one handleRefresh. It carries no id, so the copies never
 * collide.
 */
function RefreshButton({ fetching, onRefresh }: { fetching: boolean; onRefresh: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0"
      onClick={onRefresh}
      // Not `disabled`: every background refetch would drop keyboard
      // focus to <body>. handleRefresh ignores a press while its own
      // refresh is in flight, cancels a background one, and aria-busy
      // says a check is running.
      aria-busy={fetching}
      aria-label="Refresh status now"
    >
      <RefreshCw className={cn("size-3.5", fetching && "animate-spin")} />
      <span className="hidden sm:inline">Refresh</span>
    </Button>
  );
}

function AlertsButton({ state, onToggle }: { state: AlertsState; onToggle: () => void }) {
  // Two copies render, one in the compact header, so the hint's id is per copy.
  const hintId = useId();
  if (state === "unsupported") return null;
  const Icon = state === "on" ? BellRing : state === "blocked" ? BellOff : Bell;
  const blocked = state === "blocked";
  return (
    <>
      <Button
        variant={state === "on" ? "default" : "outline"}
        size="sm"
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
