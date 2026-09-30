import { cn } from "@/lib/utils";

/**
 * An on/off switch: a button with role="switch", named and described by
 * text the caller renders, so the label stays readable next to it.
 */
export function Switch({
  checked,
  onCheckedChange,
  labelledBy,
  describedBy,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  labelledBy: string;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={() => onCheckedChange(!checked)}
      className="focus-ring pressable flex shrink-0 items-center gap-2 rounded-md py-1 pr-1 pl-2 text-footnote text-muted"
    >
      <span aria-hidden className="w-6 text-right">
        {checked ? "On" : "Off"}
      </span>
      {/* The border and ButtonText thumb keep the switch drawn in forced-colors mode. Track md, thumb md less the 2px inset. */}
      <span
        aria-hidden
        className={cn(
          "flex h-6 w-10 items-center rounded-md border border-hairline p-0.5 transition-colors duration-[var(--t-quick)]",
          checked ? "bg-accent" : "bg-inset",
        )}
      >
        <span
          className={cn(
            "size-[18px] rounded-thumb transition-transform duration-[var(--t-quick)] ease-[var(--ease-out)] motion-reduce:transition-none forced-colors:bg-[ButtonText]",
            checked ? "translate-x-4 bg-bg" : "translate-x-0 bg-muted",
          )}
        />
      </span>
    </button>
  );
}
