import { useCallback, useEffect, useState } from "react";
import { applyReduceGlass, readReduceGlass, reduceGlassFromStorageEvent, writeReduceGlass } from "@/lib/status/glass";

const storage = () => window.localStorage;

/**
 * Whether this browser asked for Reduce glass. The server renders it off,
 * and the stored choice loads after hydration, so both render the same
 * markup; the boot script in <head> has already set the attribute on
 * <html> by then (REDUCE_GLASS_BOOT_SCRIPT). Another tab changing it
 * updates this one too.
 */
export function useReduceGlass(): { enabled: boolean; setEnabled: (on: boolean) => void } {
  const [enabled, setEnabledState] = useState(false);

  const show = useCallback((on: boolean) => {
    setEnabledState(on);
    applyReduceGlass(document.documentElement, on);
  }, []);

  useEffect(() => {
    show(readReduceGlass(storage));
    const onStorage = (event: StorageEvent) => {
      const next = reduceGlassFromStorageEvent(event);
      if (next !== null) show(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [show]);

  const setEnabled = useCallback(
    (on: boolean) => {
      writeReduceGlass(storage, on);
      show(on);
    },
    [show],
  );

  return { enabled, setEnabled };
}
