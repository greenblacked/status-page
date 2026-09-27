import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { SHORTCUT_HELP } from "@/lib/status/shortcuts";
import { cn } from "@/lib/utils";

/**
 * The list of keyboard shortcuts, in a native modal <dialog>: it traps focus,
 * closes on Escape and returns focus to where it was, without a library.
 * It also holds the switch for the single-key shortcuts.
 */
export function ShortcutsDialog({
  open,
  onClose,
  singleKey,
  onSingleKeyChange,
}: {
  open: boolean;
  onClose: () => void;
  singleKey: boolean;
  onSingleKeyChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // A click on the backdrop lands on the dialog itself, not its content.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-labelledby="shortcuts-heading"
      className="m-auto w-[min(26rem,calc(100vw-2rem))] bg-transparent p-0 text-fg backdrop:bg-bg/70 backdrop:backdrop-blur-sm"
    >
      <div className="glass rounded-3xl p-5 sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <h2 id="shortcuts-heading" className="font-display text-xl font-medium tracking-[-0.03em]">
            Keyboard shortcuts
          </h2>
          <Button variant="ghost" size="icon" className="-my-2 -mr-2" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>
        <div className="mt-4 flex items-center justify-between gap-4 rounded-2xl glass-inset px-3 py-2.5">
          <div className="min-w-0">
            <p id="single-key-label" className="text-sm text-fg">
              Single-key shortcuts
            </p>
            <p id="single-key-hint" className="mt-0.5 text-xs text-muted text-pretty">
              The letter and number keys. Switch them off for speech input, or if they get in the way.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={singleKey}
            aria-labelledby="single-key-label"
            aria-describedby="single-key-hint"
            onClick={() => onSingleKeyChange(!singleKey)}
            className="focus-ring flex shrink-0 items-center gap-2 rounded-full py-1 pr-1 pl-2 font-mono text-[11px] uppercase text-muted"
          >
            <span aria-hidden className="w-6 text-right">
              {singleKey ? "On" : "Off"}
            </span>
            {/* The border and ButtonText thumb keep the switch drawn in forced-colors mode. */}
            <span
              aria-hidden
              className={cn(
                "flex h-6 w-10 items-center rounded-full border border-border p-0.5 transition-colors duration-[var(--motion-quick)]",
                singleKey ? "bg-accent" : "bg-surface-2",
              )}
            >
              <span
                className={cn(
                  "size-4.5 rounded-full transition-transform duration-[var(--motion-quick)] ease-[var(--ease-out)] motion-reduce:transition-none forced-colors:bg-[ButtonText]",
                  singleKey ? "translate-x-4 bg-bg" : "translate-x-0 bg-fg/70",
                )}
              />
            </span>
          </button>
        </div>
        <dl className="mt-4 flex flex-col gap-2">
          {SHORTCUT_HELP.map((item) => {
            const off = item.singleKey && !singleKey;
            return (
              <div
                key={item.label}
                className={cn("flex items-center justify-between gap-4 text-sm", off && "opacity-50")}
              >
                <dt className="text-muted">
                  {item.label}
                  {off ? <span className="sr-only"> (switched off)</span> : null}
                </dt>
                <dd className="flex shrink-0 gap-1">
                  {item.keys.map((key) => (
                    <kbd
                      key={key}
                      className={cn(
                        "min-w-7 rounded-lg glass-inset px-2 py-0.5 text-center font-mono text-xs text-fg",
                        off && "line-through",
                      )}
                    >
                      {key}
                    </kbd>
                  ))}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </dialog>
  );
}
