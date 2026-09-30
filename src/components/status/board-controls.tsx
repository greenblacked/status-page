import { Bell, BellOff, BellRing, RefreshCw, Search, Star, TriangleAlert, X } from "lucide-react";
import { type ComponentProps, type ReactNode, type RefObject, useEffect, useId, useState } from "react";
import { useDockState } from "@/components/status/compact-header";
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
 * Hands its children whether the floating bar is up. It is the one part of the
 * hero that renders when that changes, so the board does not.
 */
export function WhileBarUp({ store, children }: { store: DockStore; children: (barUp: boolean) => ReactNode }) {
  return children(useDockState(store).barShown);
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
export function SearchInput({
  store,
  dockRef,
  ...props
}: { store: DockStore; dockRef: RefObject<HTMLElement | null> } & ComponentProps<typeof Input>) {
  const { docked } = useDockState(store);
  const fits = usePlaceholderFits(LONG_PLACEHOLDER, dockRef);
  return <Input placeholder={docked || !fits ? SHORT_PLACEHOLDER : LONG_PLACEHOLDER} {...props} />;
}

/** The magnifier, the field, the `/` hint and our own Clear button, inside the dock. */
export function SearchField({
  store,
  dockRef,
  inputRef,
  query,
  onQuery,
  showSlash,
}: {
  store: DockStore;
  dockRef: RefObject<HTMLElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (query: string) => void;
  /** Single-key shortcuts are on: the field says `/` reaches it. */
  showSlash: boolean;
}) {
  return (
    <div className="search-field">
      <label className="relative block min-w-0 flex-1">
        <span className="sr-only">Search services</span>
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-subtle" />
        <SearchInput
          ref={inputRef}
          store={store}
          dockRef={dockRef}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          type="search"
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className={cn("appearance-none pl-10", query ? "pr-11" : "sm:pr-10")}
        />
        {showSlash && !query ? (
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
