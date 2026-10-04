import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { TiltStatus } from "@/components/status/use-tilt-lighting";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { BACKGROUNDS, type Background } from "@/lib/status/background";
import { SHORTCUT_HELP } from "@/lib/status/shortcuts";
import { cn } from "@/lib/utils";

/** What each background says about itself, under the choice. */
const BACKGROUND_LABEL: Record<Background, string> = { quiet: "Quiet", glass: "Glass", full: "Full" };
const BACKGROUND_HINT: Record<Background, string> = {
  quiet: "Flat paper. Nothing moves behind the page.",
  glass: "Frosted panels over a still glow, with a soft light that wanders across the cards.",
  full: "Adds the slow drift and glass lenses to Glass.",
};

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
  background,
  tilt,
}: {
  open: boolean;
  onClose: () => void;
  singleKey: boolean;
  onSingleKeyChange: (on: boolean) => void;
  reduceGlass: boolean;
  onReduceGlassChange: (on: boolean) => void;
  /** The page behind the board: Quiet (the default), Glass or Full. */
  background: { value: Background; onChange: (value: Background) => void };
  /** Tilt lighting; the row shows only where the device can report its tilt. */
  tilt: { supported: boolean; enabled: boolean; status: TiltStatus; onChange: (on: boolean) => void };
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Tilt lighting only draws on Glass and Full, so on Quiet "paused" means "needs a background", unless Reduce glass says why.
  const tiltNote =
    tilt.status === "paused" && background.value === "quiet" && !reduceGlass
      ? "Needs the Glass or Full background."
      : (TILT_NOTES[tilt.status] ?? "");

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
      className="settings-dialog m-auto max-h-[calc(100dvh-2rem)] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain bg-transparent p-0 text-fg backdrop:bg-bg/70"
    >
      {/* The floating layer. The backdrop only dims, so two blurs never stack. */}
      <div className="sheet p-5 sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <h2 id="settings-heading" className="text-card">
            Settings
          </h2>
          <Button variant="ghost" size="icon" className="-my-2 -mr-2" onClick={onClose} aria-label="Close settings">
            <X />
          </Button>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <fieldset className="inset rounded-md p-3" aria-describedby="background-hint">
            <legend className="float-left mb-2 w-full p-0 text-caption font-semibold text-muted">Background</legend>
            <div className="control clear-both flex p-0.5">
              {BACKGROUNDS.map((value) => (
                <label
                  key={value}
                  className={cn(
                    "flex min-h-9 flex-1 cursor-pointer items-center justify-center rounded-thumb text-center text-caption pointer-coarse:min-h-10",
                    "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                    "text-muted has-[:checked]:bg-card has-[:checked]:font-semibold has-[:checked]:text-fg has-[:checked]:shadow-[inset_0_0_0_var(--hair)_var(--color-hairline)]",
                  )}
                >
                  <input
                    type="radio"
                    name="background"
                    value={value}
                    className="sr-only"
                    checked={background.value === value}
                    onChange={() => background.onChange(value)}
                  />
                  {BACKGROUND_LABEL[value]}
                </label>
              ))}
            </div>
            <p id="background-hint" role="status" className="mt-2 text-caption text-muted">
              {BACKGROUND_HINT[background.value]}
              {reduceGlass ? " Reduce glass is on, so the page stays solid." : ""}
            </p>
          </fieldset>
          <Setting
            id="reduce-glass"
            label="Reduce glass"
            hint="Solid panels and a still background. Easier to read, lighter on old phones."
            checked={reduceGlass}
            onCheckedChange={onReduceGlassChange}
          />
          {tilt.supported ? (
            <Setting
              id="tilt-lighting"
              label="Tilt lighting"
              hint="Highlights follow your phone's tilt. Asks for motion access the first time."
              checked={tilt.enabled}
              onCheckedChange={tilt.onChange}
              note={tiltNote}
            />
          ) : null}
          <Setting
            id="single-key"
            label="Single-key shortcuts"
            hint="Letter and number keys. Turn them off if they clash with voice input. Esc still works."
            checked={singleKey}
            onCheckedChange={onSingleKeyChange}
          />
        </div>
        <h3 className="mt-5 text-caption font-semibold text-muted">Keyboard shortcuts</h3>
        <dl className="mt-3 flex flex-col gap-2">
          {SHORTCUT_HELP.map((item) => {
            const off = item.singleKey && !singleKey;
            return (
              // Dimmed by colour, not opacity: at half opacity the switched-off
              // rows fell under 4.5:1, and they still have to be readable.
              <div key={item.label} className="flex items-center justify-between gap-4 text-caption">
                <dt className={off ? "text-subtle" : "text-muted"}>
                  {item.label}
                  {off ? <span className="sr-only"> (switched off)</span> : null}
                </dt>
                <dd className="flex shrink-0 gap-1">
                  {item.keys.map((key) => (
                    <kbd
                      key={key}
                      className={cn(
                        "min-w-7 rounded-sm border border-hairline px-2 py-0.5 text-center text-footnote",
                        off ? "text-subtle line-through" : "text-fg",
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

/** What Tilt lighting says when it is not simply on or off. */
const TILT_NOTES: Partial<Record<TiltStatus, string>> = {
  denied: "Motion access was declined. Quit the browser and reopen this page to be asked again.",
  "no-sensor": "This device has no motion sensor.",
  "no-readings": "No motion readings arrived from this device.",
  "no-readings-dropped": "Your device sent no motion data, so I switched tilt lighting off.",
  "needs-permission": "Motion access lapsed. Turn the switch off and on to allow it again.",
  paused: "Paused while Reduce glass or Reduce Motion is on.",
};

/** One switch row: the label and hint name and describe the switch. `note` is a live line under it. */
function Setting({
  id,
  label,
  hint,
  checked,
  onCheckedChange,
  note,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
  note?: string;
}) {
  return (
    // 16px sheet corner minus its 20px padding leaves the md step for a row.
    <div className="inset flex items-center justify-between gap-4 rounded-md px-3 py-3">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-body text-fg">
          {label}
        </p>
        <p id={`${id}-hint`} className="mt-0.5 text-caption text-muted text-pretty">
          {hint}
        </p>
        {note === undefined ? null : (
          <p role="status" className="mt-1 text-caption text-fg text-pretty empty:hidden">
            {note}
          </p>
        )}
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
