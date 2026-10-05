import { THEME_ATTRIBUTE } from "@/lib/theme";

type FakeElement = {
  tag: string;
  attributes: Map<string, string>;
  parentNode: FakeParent | null;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
};
type FakeParent = {
  children: FakeElement[];
  insertBefore(node: FakeElement, before: FakeElement): void;
  appendChild(node: FakeElement): void;
};

/**
 * A stand-in for the part of a document the theme code writes: <html>, and a <head> that may hold theme-color metas.
 * `querySelector` understands the two selectors it uses. Cast it where a `Document` is wanted.
 */
export function fakeDocument(options: { serverMetas?: number; attribute?: string } = {}) {
  const element = (tag: string, parent: FakeParent | null = null): FakeElement => {
    const attributes = new Map<string, string>();
    return {
      tag,
      attributes,
      parentNode: parent,
      setAttribute: (name, value) => void attributes.set(name, value),
      getAttribute: (name) => attributes.get(name) ?? null,
    };
  };
  const head: FakeParent = {
    children: [],
    insertBefore(node, before) {
      node.parentNode = head;
      head.children.splice(head.children.indexOf(before), 0, node);
    },
    appendChild(node) {
      node.parentNode = head;
      head.children.push(node);
    },
  };
  for (let at = 0; at < (options.serverMetas ?? 0); at++) {
    const meta = element("meta", head);
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", at === 0 ? "server-light" : "server-dark");
    head.children.push(meta);
  }
  const html = element("html");
  if (options.attribute) html.setAttribute(THEME_ATTRIBUTE, options.attribute);
  const doc = {
    documentElement: html,
    head,
    createElement: (tag: string) => element(tag),
    querySelector(selector: string) {
      const bare = /^meta\[([a-z-]+)\]$/.exec(selector);
      if (bare) return head.children.find((child) => child.attributes.has(bare[1] as string)) ?? null;
      const named = /^meta\[name="([a-z-]+)"\]$/.exec(selector);
      if (named) return head.children.find((child) => child.getAttribute("name") === named[1]) ?? null;
      throw new Error(`the fake document does not know ${selector}`);
    },
  };
  return {
    doc,
    html,
    head,
    /** The theme-color the page would answer with: the first meta in the head. */
    firstThemeColor: () =>
      head.children.find((child) => child.getAttribute("name") === "theme-color")?.getAttribute("content"),
    /** The metas the scripts wrote. */
    written: () => head.children.filter((child) => child.attributes.has("data-theme-color")),
  };
}
