import { useCallback, useEffect, useState } from "react";
import {
  applyReduceGlass,
  parseReduceGlassPreference,
  REDUCE_GLASS_STORAGE_KEY,
  serializeReduceGlassPreference,
} from "@/lib/status/glass";

function read(): boolean {
  try {
    return parseReduceGlassPreference(window.localStorage.getItem(REDUCE_GLASS_STORAGE_KEY));
  } catch {
    return false;
  }
}

function write(on: boolean): void {
  try {
    window.localStorage.setItem(REDUCE_GLASS_STORAGE_KEY, serializeReduceGlassPreference(on));
  } catch {
    // Private windows can refuse storage; the choice then lasts for this visit.
  }
}

/**
 * Whether this browser asked for Reduce glass. The server renders it off,
 * and the stored choice loads after hydration, so both render the same
 * markup; the boot script in <head> has already set the attribute on
 * <html> by then (REDUCE_GLASS_BOOT_SCRIPT). Another tab changing it
 * updates this one too.
 */
export function useReduceGlass(): { enabled: boolean; setEnabled: (on: boolean) => void } {
  const [enabled, setEnabledState] = useState(false);

  useEffect(() => {
    const show = (on: boolean) => {
      setEnabledState(on);
      applyReduceGlass(document.documentElement, on);
    };
    show(read());
    const onStorage = (event: StorageEvent) => {
      // A null key is localStorage.clear() in another tab: back to the default.
      if (event.key === null) show(parseReduceGlassPreference(null));
      else if (event.key === REDUCE_GLASS_STORAGE_KEY) show(parseReduceGlassPreference(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setEnabled = useCallback((on: boolean) => {
    write(on);
    setEnabledState(on);
    applyReduceGlass(document.documentElement, on);
  }, []);

  return { enabled, setEnabled };
}
