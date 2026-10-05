import { describe, expect, it, vi } from "vitest";
import { THEME_ATTRIBUTE, THEME_REFRESH_MS, THEME_STORAGE_KEY, type ThemeStorage } from "./theme";
import { createThemeStore, type ThemeEnv } from "./theme-store";

/** A page the store can run in: a clock, storage that can be made to refuse, <html>, and the events it listens to. */
function page(options: { hour: number; stored?: string; refuse?: boolean; attribute?: string }) {
  const state = {
    hour: options.hour,
    refuse: options.refuse ?? false,
    visibility: "visible",
    attribute: options.attribute as string | undefined,
    metas: [new Map<string, string>()],
    data: new Map<string, string>(options.stored ? [[THEME_STORAGE_KEY, options.stored]] : []),
  };
  const handlers = {
    storage: new Set<(event: { key: string | null }) => void>(),
    pageshow: new Set<(event: { key: string | null }) => void>(),
    visibilitychange: new Set<() => void>(),
  };
  let tick: (() => void) | undefined;
  const storage: ThemeStorage = {
    getItem: (key) => {
      if (state.refuse) throw new Error("blocked");
      return state.data.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (state.refuse) throw new Error("blocked");
      state.data.set(key, value);
    },
  };
  const env: ThemeEnv = {
    storage: () => storage,
    now: () => ({ getHours: () => state.hour }) as Date,
    doc: {
      get visibilityState() {
        return state.visibility;
      },
      documentElement: {
        getAttribute: (name) => (name === THEME_ATTRIBUTE ? (state.attribute ?? null) : null),
        setAttribute: (name, value) => {
          if (name === THEME_ATTRIBUTE) state.attribute = value;
        },
      },
      querySelectorAll: () =>
        state.metas.map((meta) => ({ setAttribute: (name: string, value: string) => void meta.set(name, value) })),
      addEventListener: (_type, listener) => void handlers.visibilitychange.add(listener),
      removeEventListener: (_type, listener) => void handlers.visibilitychange.delete(listener),
    },
    win: {
      addEventListener: (type, listener) => void handlers[type].add(listener),
      removeEventListener: (type, listener) => void handlers[type].delete(listener),
    },
    setInterval: (handler, ms) => {
      expect(ms).toBe(THEME_REFRESH_MS);
      tick = handler;
      return 1;
    },
    clearInterval: () => {
      tick = undefined;
    },
  };
  return {
    state,
    env,
    handlers,
    tick: () => tick?.(),
    ticking: () => tick !== undefined,
    storageEvent: (key: string | null) => {
      for (const handler of handlers.storage) handler({ key });
    },
    visibilityChange: () => {
      for (const handler of handlers.visibilitychange) handler();
    },
  };
}

describe("createThemeStore", () => {
  it("reads the attribute the boot script wrote", () => {
    const p = page({ hour: 12, attribute: "night" });
    expect(createThemeStore(p.env).getSnapshot()).toBe("night");
  });

  it("falls to the rule when the attribute is missing, and applies it on subscribe", () => {
    const p = page({ hour: 22 });
    const store = createThemeStore(p.env);
    expect(store.getSnapshot()).toBe("night");
    const listener = vi.fn();
    store.subscribe(listener);
    expect(p.state.attribute).toBe("night");
    expect(p.state.metas[0]?.get("content")).toBe("#000000");
  });

  it("toggles to the opposite, stores it, applies it and tells the listeners", () => {
    const p = page({ hour: 12, attribute: "day" });
    const store = createThemeStore(p.env);
    const listener = vi.fn();
    store.subscribe(listener);
    store.toggle();
    expect(store.getSnapshot()).toBe("night");
    expect(p.state.data.get(THEME_STORAGE_KEY)).toBe("night");
    expect(p.state.metas[0]?.get("content")).toBe("#000000");
    expect(listener).toHaveBeenCalledTimes(1);
    store.toggle();
    expect(p.state.data.get(THEME_STORAGE_KEY)).toBe("day");
    expect(p.state.metas[0]?.get("content")).toBe("#f4f1eb");
  });

  it("re-reads the rule every 60 seconds and follows the clock only when nothing is stored", () => {
    const p = page({ hour: 19, attribute: "day" });
    const store = createThemeStore(p.env);
    const listener = vi.fn();
    store.subscribe(listener);
    p.state.hour = 20;
    p.tick();
    expect(store.getSnapshot()).toBe("night");
    expect(listener).toHaveBeenCalledTimes(1);
    p.tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps a stored choice through the clock changing", () => {
    const p = page({ hour: 12, stored: "day", attribute: "day" });
    const store = createThemeStore(p.env);
    store.subscribe(() => {});
    p.state.hour = 23;
    p.tick();
    p.visibilityChange();
    expect(store.getSnapshot()).toBe("day");
  });

  it("re-reads when a hidden tab becomes visible, and not while it stays hidden", () => {
    const p = page({ hour: 12, attribute: "day" });
    const store = createThemeStore(p.env);
    store.subscribe(() => {});
    p.state.hour = 21;
    p.state.visibility = "hidden";
    p.visibilityChange();
    expect(store.getSnapshot()).toBe("day");
    p.state.visibility = "visible";
    p.visibilityChange();
    expect(store.getSnapshot()).toBe("night");
  });

  it("re-reads when the page returns from the back-forward cache", () => {
    const p = page({ hour: 12, attribute: "day" });
    const store = createThemeStore(p.env);
    store.subscribe(() => {});
    p.state.hour = 21;
    for (const handler of p.handlers.pageshow) handler({ key: null });
    expect(store.getSnapshot()).toBe("night");
  });

  it("follows another tab's choice, and ignores another key", () => {
    const p = page({ hour: 12, attribute: "day" });
    const store = createThemeStore(p.env);
    const listener = vi.fn();
    store.subscribe(listener);
    p.state.data.set(THEME_STORAGE_KEY, "night");
    p.storageEvent("status-bar:background");
    expect(store.getSnapshot()).toBe("day");
    p.storageEvent(THEME_STORAGE_KEY);
    expect(store.getSnapshot()).toBe("night");
    p.state.data.clear();
    p.storageEvent(null);
    expect(store.getSnapshot()).toBe("day");
  });

  it("holds a press that storage refused, for this visit, and lets another tab's choice replace it", () => {
    const p = page({ hour: 12, attribute: "day", refuse: true });
    const store = createThemeStore(p.env);
    store.subscribe(() => {});
    store.toggle();
    expect(store.getSnapshot()).toBe("night");
    p.tick();
    p.visibilityChange();
    expect(store.getSnapshot()).toBe("night");
    store.toggle();
    expect(store.getSnapshot()).toBe("day");
    p.tick();
    expect(store.getSnapshot()).toBe("day");
    p.storageEvent(THEME_STORAGE_KEY);
    expect(store.getSnapshot()).toBe("day");
  });

  it("runs its clock and listeners only while something subscribes", () => {
    const p = page({ hour: 12, attribute: "day" });
    const store = createThemeStore(p.env);
    expect(p.ticking()).toBe(false);
    const first = store.subscribe(() => {});
    const second = store.subscribe(() => {});
    expect(p.ticking()).toBe(true);
    expect(p.handlers.storage.size).toBe(1);
    first();
    expect(p.ticking()).toBe(true);
    second();
    expect(p.ticking()).toBe(false);
    expect(p.handlers.storage.size).toBe(0);
    expect(p.handlers.pageshow.size).toBe(0);
    expect(p.handlers.visibilitychange.size).toBe(0);
  });
});
