import { useTheme } from "@/components/status/use-theme";
import { cn } from "@/lib/utils";

/**
 * The day/night switch: a Material 3 switch (52 by 32 track, 24px knob that carries a sun by day and a moon by
 * night and slides 20px), drawn in the board's tokens. A real <button> with role="switch"; aria-checked is true
 * at night. Everything the eye sees follows <html data-theme> in the style sheet (.theme-switch), which the boot
 * script sets before the first paint, so the knob is already where it belongs and never slides on load; only
 * aria-checked waits for React. It renders in the hero and in the floating bar like the other controls, each
 * copy with the same name.
 */
export function ThemeSwitch({ skipTab, className }: { skipTab?: boolean; className?: string }) {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={theme === "night"}
      aria-label="Dark theme"
      title="Dark theme"
      tabIndex={skipTab ? -1 : undefined}
      onClick={toggle}
      data-theme-switch
      className={cn(
        "theme-switch focus-ring pressable inline-flex h-[44px] min-w-[52px] shrink-0 items-center justify-center rounded-md",
        className,
      )}
    >
      <span aria-hidden className="theme-track">
        <span className="theme-knob">
          <svg viewBox="0 0 16 16" className="theme-sun" aria-hidden focusable="false">
            <circle cx="8" cy="8" r="2.4" fill="currentColor" />
            <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" />
            </g>
          </svg>
          <svg viewBox="0 0 16 16" className="theme-moon" aria-hidden focusable="false">
            <path fill="currentColor" d="M9.6 2.2a5.8 5.8 0 1 0 4.2 9.6 5.2 5.2 0 0 1-4.2-9.6Z" />
          </svg>
        </span>
      </span>
    </button>
  );
}
