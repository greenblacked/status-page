import { Bell, BellOff, BellRing, RefreshCw, Search, Star, TriangleAlert, X } from "lucide-react";
import {
  type ChangeEvent,
  type ComponentProps,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useState,
} from "react";
import { useDockSelect } from "@/components/status/compact-header";
import { useBarWide } from "@/components/status/live-bar";
import type { AlertsState } from "@/components/status/use-alerts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { CATEGORIES } from "@/lib/status/catalog";
import type { DockStore } from "@/lib/status/dock";
import type { BoardFilters } from "@/lib/status/filters";
import { canvasFont, placeholderFits } from "@/lib/status/placeholder";
import type { CategoryId } from "@/lib/status/types";
import { cn } from "@/lib/utils";

const ALERT_TITLE: Record<AlertsState, string> = {
  unsupported: "This browser can't send notifications.",
  off: "Notify me when a service changes",
  on: "Notifications on. Press to turn off.",
  blocked: "Notifications are blocked for this site. Allow them in browser settings.",
};

/**
 * Hands its children whether the floating bar is up, and whether it carries a
 * copy of the day/night switch (up, and 640px or wider: below that the switch is
 * left out of the bar). It is the one part of the hero that renders when that
 * changes, so the board does not.
 */
export function WhileBarUp({
  store,
  children,
}: {
  store: DockStore;
  children: (barUp: boolean, barHasSwitch: boolean) => ReactNode;
}) {
  const barUp = useDockSelect(store, (state) => state.barShown);
  const wide = useBarWide();
  return children(barUp, barUp && wide);
}

/**
 * Rendered twice, in the hero and in the floating bar, both driven by the
 * board's one handleRefresh. It carries no id, so the copies never collide.
 * Icon only: the name is the label, the title is its tooltip. The hero's copy
 * leaves the Tab order while the bar is up (`skipTab`).
 */
export function RefreshButton({
  skipTab,
  fetching,
  onRefresh,
}: {
  skipTab?: boolean;
  fetching: boolean;
  onRefresh: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="shrink-0 [&_svg]:size-5"
      tabIndex={skipTab ? -1 : undefined}
      onClick={onRefresh}
      // Not `disabled`: every background refetch would drop keyboard
      // focus to <body>. handleRefresh ignores a press while its own
      // refresh is in flight, cancels a background one, and aria-busy
      // says a check is running.
      aria-busy={fetching}
      aria-label="Refresh status now"
      title="Refresh status now"
    >
      <RefreshCw className={cn(fetching && "motion-safe:animate-spin")} />
    </Button>
  );
}

export function AlertsButton({
  skipTab,
  state,
  onToggle,
}: {
  skipTab?: boolean;
  state: AlertsState;
  onToggle: () => void;
}) {
  // Two copies render, one in the floating bar, so the hint's id is per copy.
  const hintId = useId();
  if (state === "unsupported") return null;
  const Icon = state === "on" ? BellRing : state === "blocked" ? BellOff : Bell;
  const blocked = state === "blocked";
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={cn("shrink-0 [&_svg]:size-5", state === "on" && "text-accent hover:text-accent")}
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
        aria-label="Notifications"
        data-alerts-toggle
        title={ALERT_TITLE[state]}
      >
        <Icon />
      </Button>
      {blocked ? (
        <span id={hintId} className="sr-only">
          Blocked in this browser's site settings
        </span>
      ) : null}
    </>
  );
}

const LONG_PLACEHOLDER = "Search GCP, CS2 Europe, RouterOS…";
const SHORT_PLACEHOLDER = "Search…";

/**
 * Whether `text` fits the field as a placeholder, unclipped. The field at rest
 * is as wide as its dock (`dockRef`, which moving into the bar never
 * resizes), so this measures the text against that width less the input's own
 * padding, and again when either changes. True until measured, which is what
 * the server rendered, so hydration sees the same placeholder.
 */
function usePlaceholderFits(text: string, dockRef: RefObject<HTMLElement | null> | undefined): boolean {
  const [fits, setFits] = useState(true);
  useEffect(() => {
    const dock = dockRef?.current;
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

type SearchInputProps = {
  store: DockStore;
  /** Which of the two fields this is; the hero's by default. */
  placement?: "hero" | "bar";
  /** The hero's dock, which the placeholder is measured against. The bar's copy has no use for it. */
  dockRef?: RefObject<HTMLElement | null>;
} & ComponentProps<typeof Input>;

/**
 * The search field's input, in two places. The hero's has the long placeholder, unless the field, at rest, is too
 * narrow to show it whole (a small phone, or beside the chips just past 1024px), and the short one once it has
 * docked into the bar on a wide screen. Below 64rem it leaves the Tab order (`tabIndex` -1) while the bar's copy
 * is the one in reach (`heroAway`). The bar's copy always has the short placeholder, and can be reached only when
 * `heroAway` (SearchField makes it `inert` until then). Focusing it shows it (`revealed`), which covers a tap,
 * Tab and `/`. Both carry `data-search-input`, which holds the bar's direction rule while either has focus.
 */
export function SearchInput({ store, dockRef, placement = "hero", ...props }: SearchInputProps) {
  return placement === "bar" ? (
    <BarSearchInput store={store} {...props} />
  ) : (
    <HeroSearchInput store={store} dockRef={dockRef} {...props} />
  );
}

function HeroSearchInput({
  store,
  dockRef,
  ...props
}: { store: DockStore; dockRef?: RefObject<HTMLElement | null> } & ComponentProps<typeof Input>) {
  const short = useDockSelect(store, (state) => state.docked);
  const heroAway = useDockSelect(store, (state) => state.heroAway);
  const fits = usePlaceholderFits(LONG_PLACEHOLDER, dockRef);
  return (
    <Input
      placeholder={short || !fits ? SHORT_PLACEHOLDER : LONG_PLACEHOLDER}
      tabIndex={heroAway ? -1 : undefined}
      data-search-input="hero"
      {...props}
    />
  );
}

function BarSearchInput({ store, ...props }: { store: DockStore } & ComponentProps<typeof Input>) {
  return (
    <Input
      placeholder={SHORT_PLACEHOLDER}
      data-search-input="bar"
      onFocus={() => {
        const state = store.get();
        if (state.heroAway) store.set({ ...state, revealed: true });
      }}
      {...props}
    />
  );
}

/**
 * The magnifier, the field, the `/` hint and our own Clear button. In the hero it sits inside the dock; the
 * bar's copy (`placement="bar"`) fills the bar's slot, has the short placeholder, no `/` hint and no landmark.
 */
export function SearchField({
  store,
  dockRef,
  inputRef,
  query,
  onQuery,
  showSlash,
  placement = "hero",
}: {
  store: DockStore;
  dockRef?: RefObject<HTMLElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (query: string) => void;
  /** Single-key shortcuts are on: the field says `/` reaches it. */
  showSlash: boolean;
  placement?: "hero" | "bar";
}) {
  const bar = placement === "bar";
  const heroAway = useDockSelect(store, (state) => state.heroAway);
  const common = {
    ref: inputRef,
    value: query,
    onChange: (event: ChangeEvent<HTMLInputElement>) => onQuery(event.target.value),
    type: "search",
    enterKeyHint: "search",
    autoCapitalize: "off",
    autoCorrect: "off",
    autoComplete: "off",
    spellCheck: false,
    className: cn("appearance-none pl-10", query ? "pr-11" : !bar && "sm:pr-10"),
  } as const;
  return (
    // The bar's copy: not reachable until the hero's field is behind the bar. Opacity hides it otherwise, not
    // visibility, so that Tab from the bar's lead lands here and not on the hero's field far above.
    <div className="search-field" inert={bar && !heroAway}>
      {/* The field's fill, drawn behind the input (which is see-through); see .search-chrome in styles.css. */}
      <span aria-hidden className="control search-chrome" />
      <label className="relative block min-w-0 flex-1">
        <span className="sr-only">Search services</span>
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-subtle" />
        <SearchInput placement={placement} store={store} dockRef={dockRef} {...common} />
        {!bar && showSlash && !query ? (
          <kbd
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-3.5 hidden -translate-y-1/2 rounded-sm px-1.5 text-footnote text-subtle shadow-[inset_0_0_0_var(--hair)_var(--color-hairline)] sm:block"
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
          // The hero's leaves the Tab order with its field while the bar's copy is the one in reach.
          tabIndex={!bar && heroAway ? -1 : undefined}
          className="focus-ring pressable absolute top-0 right-0 flex size-11 items-center justify-center rounded-md text-subtle hover:text-fg"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            onQuery("");
            inputRef.current?.focus();
          }}
        >
          <X className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

const CATEGORY_OPTIONS: Array<{ value: "all" | CategoryId; label: string }> = [
  { value: "all", label: "All" },
  ...CATEGORIES.map((category) => ({ value: category.id, label: category.label })),
];

/**
 * The filters: the category segments, and beside them two toggles, Issues
 * only and Starred. One landmark, one label. The counts show from the desktop
 * breakpoint up; on a phone only Issues keeps its own.
 */
export function FilterBar({
  filters,
  onChange,
  categoryCount,
  issueCount,
  starredCount,
}: {
  filters: BoardFilters;
  onChange: (patch: Partial<BoardFilters>) => void;
  categoryCount: (id: "all" | CategoryId) => number;
  issueCount: number;
  starredCount: number;
}) {
  const { category, issuesOnly, starredOnly } = filters;
  return (
    <>
      <Segmented
        label="Category"
        value={category}
        onChange={(next) => onChange({ category: next })}
        options={CATEGORY_OPTIONS.map((option) => ({ ...option, count: categoryCount(option.value) }))}
        className="max-w-full"
      />
      <div className="flex shrink-0 gap-2">
        <Button
          variant="control"
          size="sm"
          className="shrink-0"
          aria-pressed={issuesOnly}
          onClick={() => onChange({ issuesOnly: !issuesOnly })}
        >
          <TriangleAlert aria-hidden />
          Issues only
          <span className="font-normal tabular-nums text-subtle">{issueCount}</span>
        </Button>
        <Button
          variant="control"
          size="sm"
          className="shrink-0"
          aria-pressed={starredOnly}
          onClick={() => onChange({ starredOnly: !starredOnly })}
        >
          <Star aria-hidden className={cn(starredOnly && "fill-current")} />
          Starred
          {starredCount > 0 ? <span className="font-normal tabular-nums text-subtle">{starredCount}</span> : null}
        </Button>
      </div>
    </>
  );
}
