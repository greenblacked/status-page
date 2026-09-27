import { useCallback, useEffect, useState } from "react";
import { parseStarred, STARRED_STORAGE_KEY, serializeStarred, toggleStarred } from "@/lib/status/starred";
import type { ServiceId } from "@/lib/status/types";

function read(): ReadonlySet<ServiceId> {
  try {
    return parseStarred(window.localStorage.getItem(STARRED_STORAGE_KEY));
  } catch {
    return new Set();
  }
}

function write(starred: ReadonlySet<ServiceId>): void {
  try {
    window.localStorage.setItem(STARRED_STORAGE_KEY, serializeStarred(starred));
  } catch {
    // Private windows can refuse storage; stars then last for this visit.
  }
}

/**
 * The services this browser has starred. The server renders with none, and
 * the stored list loads after hydration, so both render the same markup.
 * Another tab starring a service updates this one too.
 */
export function useStarred(): {
  starred: ReadonlySet<ServiceId>;
  /** False until the stored list has loaded, so "no stars yet" is not claimed early. */
  ready: boolean;
  toggle: (id: ServiceId) => void;
} {
  const [starred, setStarred] = useState<ReadonlySet<ServiceId>>(() => new Set());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setStarred(read());
    setReady(true);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STARRED_STORAGE_KEY) setStarred(parseStarred(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback((id: ServiceId) => {
    setStarred((current) => {
      const next = toggleStarred(current, id);
      write(next);
      return next;
    });
  }, []);

  return { starred, ready, toggle };
}
