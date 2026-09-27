import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseSingleKeyPreference,
  type ShortcutAction,
  type ShortcutOptions,
  SINGLE_KEY_STORAGE_KEY,
  serializeSingleKeyPreference,
  shortcutFor,
} from "@/lib/status/shortcuts";

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));
}

/**
 * The board's keyboard shortcuts. One window listener; `onAction` and
 * `options` always come from the latest render. An open dialog keeps its
 * keys, and so does a text field, apart from Escape.
 */
export function useShortcuts(onAction: (action: ShortcutAction) => void, options: ShortcutOptions): void {
  const latest = useRef({ onAction, options });
  useEffect(() => {
    latest.current = { onAction, options };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
      const action = shortcutFor(
        {
          key: event.key,
          code: event.code,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          repeat: event.repeat,
          editable: isEditable(event.target),
        },
        latest.current.options,
      );
      if (!action) return;
      // "/" would otherwise open Firefox's quick find.
      event.preventDefault();
      latest.current.onAction(action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function readSingleKey(): boolean {
  try {
    return parseSingleKeyPreference(window.localStorage.getItem(SINGLE_KEY_STORAGE_KEY));
  } catch {
    return true;
  }
}

function writeSingleKey(on: boolean): void {
  try {
    window.localStorage.setItem(SINGLE_KEY_STORAGE_KEY, serializeSingleKeyPreference(on));
  } catch {
    // Private windows can refuse storage; the choice then lasts for this visit.
  }
}

/**
 * Whether this browser keeps the single-key shortcuts on. The server renders
 * them on, and the stored choice loads after hydration, so both render the
 * same markup. Another tab changing it updates this one too.
 */
export function useSingleKeyShortcuts(): { enabled: boolean; setEnabled: (on: boolean) => void } {
  const [enabled, setEnabledState] = useState(true);

  useEffect(() => {
    setEnabledState(readSingleKey());
    const onStorage = (event: StorageEvent) => {
      // A null key is localStorage.clear() in another tab: back to the default.
      if (event.key === null) setEnabledState(parseSingleKeyPreference(null));
      else if (event.key === SINGLE_KEY_STORAGE_KEY) setEnabledState(parseSingleKeyPreference(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setEnabled = useCallback((on: boolean) => {
    writeSingleKey(on);
    setEnabledState(on);
  }, []);

  return { enabled, setEnabled };
}
