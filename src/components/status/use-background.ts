import { useCallback, useEffect, useState } from "react";
import {
  applyBackground,
  type Background,
  backgroundFromStorageEvent,
  DEFAULT_BACKGROUND,
  readBackground,
  writeBackground,
} from "@/lib/status/background";

const storage = () => window.localStorage;

/**
 * The page behind the board (Quiet, Glass or Full). The server renders Quiet,
 * and the stored choice loads after hydration, so both render the same markup;
 * the boot script in <head> has already set data-background on <html> by then
 * (APPEARANCE_BOOT_SCRIPT), so a visitor who chose Glass or Full never sees a
 * frame of Quiet first. Another tab changing it updates this one too.
 */
export function useBackground(): { value: Background; setValue: (value: Background) => void } {
  const [value, setValueState] = useState<Background>(DEFAULT_BACKGROUND);

  const show = useCallback((next: Background) => {
    setValueState(next);
    applyBackground(document.documentElement, next);
  }, []);

  useEffect(() => {
    show(readBackground(storage));
    const onStorage = (event: StorageEvent) => {
      const next = backgroundFromStorageEvent(event);
      if (next !== null) show(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [show]);

  const setValue = useCallback(
    (next: Background) => {
      writeBackground(storage, next);
      show(next);
    },
    [show],
  );

  return { value, setValue };
}
