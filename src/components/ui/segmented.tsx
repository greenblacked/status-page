import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** Shown beside the label, in the quiet text colour. */
  count?: number;
  /** Counts show from the desktop breakpoint up; set this to show this one on a phone too (Issues). */
  countOnPhone?: boolean;
};

/**
 * One choice out of several, drawn as a track with a thumb: the track is the
 * inset fill, the pressed option lifts to the card with a hairline. A group of
 * buttons with aria-pressed rather than a radio group, so it keeps the tab
 * stops and the names the board's other filters have. On a phone the track
 * scrolls sideways instead of wrapping. From lg up the segments are 8px
 * narrower: the desktop filter row is a fixed 696px, and with the toggles'
 * counts (Issues only 12, Starred 11) it must still hold on one line, in
 * Inter (which is wider than the fallback face here, by about 14px) and in
 * the fallback alike. The row does not wrap there (it is nowrap), so a face
 * wider still scrolls the segments by the difference instead of dropping the
 * toggles below them.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  /** The group's accessible name ("Category"). */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> cannot be this scrolling flex row in every browser; role="group" gives it the same name and grouping.
    <div
      role="group"
      aria-label={label}
      className={cn(
        "control flex min-w-0 overflow-x-auto p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {options.map((option) => {
        const pressed = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(option.value)}
            className={cn(
              "focus-ring pressable flex min-h-8 shrink-0 items-center gap-1.5 rounded-thumb px-2.5 text-caption lg:px-1.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11 justify-center",
              pressed
                ? "bg-card font-semibold text-fg shadow-[inset_0_0_0_var(--hair)_var(--color-hairline)]"
                : "text-muted hover:text-fg",
            )}
          >
            {option.label}
            {option.count === undefined ? null : (
              <span className={cn("font-normal tabular-nums text-subtle", option.countOnPhone ? "" : "max-md:hidden")}>
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
