import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SHORTCUT_HELP } from "@/lib/status/shortcuts";
import { cn } from "@/lib/utils";

/**
 * Settings and the list of keyboard shortcuts, in a native modal <dialog>:
 * it traps focus, closes on Escape and returns focus to where it was,
 * without a library. `?` and the footer button open it.
 */
export function SettingsDialog({
  open,
  onClose,
  singleKey,
  onSingleKeyChange,
  reduceGlass,
  onReduceGlassChange,
}: {
  open: boolean;
  onClose: () => void;
  singleKey: boolean;
  onSingleKeyChange: (on: boolean) => void;
  reduceGlass: boolean;
  onReduceGlassChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click only catches the backdrop; Esc closes a modal <dialog> natively.
    <dialog
      ref={ref}
      onClose={onClose}
      // A click on the backdrop lands on the dialog itself, not its content.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-labelledby="settings-heading"
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain bg-transparent p-0 text-fg backdrop:bg-bg/70"
    >
      {/* The floating layer: chrome, the strongest material. The backdrop only dims, so two blurs never stack. */}
      <div className="glass-chrome rounded-xl p-5 sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <h2 id="settings-heading" className="font-display text-xl font-medium tracking-[-0.03em]">
            Settings and shortcuts
          </h2>
          <Button variant="ghost" size="icon" className="-my-2 -mr-2" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <Setting
            id="reduce-glass"
            label="Reduce glass"
            hint="Solid panels instead of frosted glass, and a still background. Easier to read, and lighter on an older phone."
            checked={reduceGlass}
            onCheckedChange={onReduceGlassChange}
          />
          <Setting
            id="single-key"
            label="Single-key shortcuts"
            hint="Every key below but Esc. Switch them off for speech input, or if they get in the way. The search box and this list stay a Tab away."
            checked={singleKey}
            onCheckedChange={onSingleKeyChange}
          />
        </div>
        <h3 className="mt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-subtle">Keyboard shortcuts</h3>
        <dl className="mt-3 flex flex-col gap-2">
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
                        "min-w-7 rounded-2xs glass-inset px-2 py-0.5 text-center font-mono text-xs text-fg",
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

/** One switch row: the label and hint name and describe the switch. */
function Setting({
  id,
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
}) {
  return (
    // 34px dialog corner minus its 20px padding: the concentric step is 14px.
    <div className="flex items-center justify-between gap-4 rounded-sm glass-inset px-3 py-2.5">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-sm text-fg">
          {label}
        </p>
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-muted text-pretty">
          {hint}
        </p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        labelledBy={`${id}-label`}
        describedBy={`${id}-hint`}
      />
    </div>
  );
}
