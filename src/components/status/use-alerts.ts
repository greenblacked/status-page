import { useCallback, useEffect, useRef, useState } from "react";
import { alertFor } from "@/lib/status/alerts";
import { pageAlertsUnsupported } from "@/lib/status/alerts-support";
import { diffBoards } from "@/lib/status/diff";
import type { BoardSnapshot } from "@/lib/status/types";

const STORAGE_KEY = "status-bar:alerts";

export type AlertsState = "unsupported" | "off" | "on" | "blocked";

function readPreference(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function writePreference(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Private windows can refuse storage; alerts then last for this visit.
  }
}

/**
 * Opt-in browser notifications for changes between two consecutive boards.
 * They fire only while this tab is open but not being looked at: someone
 * reading the board already sees the change.
 */
export function useBoardAlerts(board: BoardSnapshot): { state: AlertsState; toggle: () => void } {
  const [state, setState] = useState<AlertsState>("off");
  const previous = useRef<BoardSnapshot | null>(null);

  useEffect(() => {
    if (!("Notification" in window)) return setState("unsupported");
    // iOS and iPadOS define Notification but never show one from a page.
    const hasPush = "serviceWorker" in navigator && "PushManager" in window;
    if (pageAlertsUnsupported(navigator, hasPush)) return setState("unsupported");
    if (Notification.permission === "denied") return setState("blocked");
    setState(readPreference() && Notification.permission === "granted" ? "on" : "off");
  }, []);

  useEffect(() => {
    const before = previous.current;
    previous.current = board;
    if (state !== "on" || !before || before.generatedAt === board.generatedAt) return;
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    for (const change of diffBoards(before, board)) {
      const message = alertFor(change);
      try {
        new Notification(message.title, { body: message.body, tag: message.tag, icon: "/favicon.svg" });
      } catch {
        // Some mobile browsers only allow notifications from a service worker.
      }
    }
  }, [board, state]);

  const toggle = useCallback(() => {
    if (state === "on") {
      writePreference(false);
      setState("off");
      return;
    }
    if (state !== "off") return;
    void Notification.requestPermission().then((permission) => {
      if (permission === "granted") {
        writePreference(true);
        setState("on");
      } else if (permission === "denied") {
        setState("blocked");
      }
    });
  }, [state]);

  return { state, toggle };
}
