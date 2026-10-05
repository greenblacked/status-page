import { describe, expect, it, vi } from "vitest";
import { below } from "./hold-place";

/** The little of an element that `below` reads: its children, its box, and whether it is or holds the feed. */
interface Fake {
  name: string;
  top: number;
  height: number;
  position?: string;
  feed?: boolean;
  holdsFeed?: boolean;
}

function column(children: Fake[]): Element {
  const element = (child: Fake) => ({
    name: child.name,
    getBoundingClientRect: () => ({ top: child.top, height: child.height }),
    matches: (selector: string) => selector === "[data-no-anchor]" && Boolean(child.feed),
    querySelector: (selector: string) => (selector === "[data-no-anchor]" && child.holdsFeed ? {} : null),
    style: { position: child.position ?? "static" },
  });
  return { name: "column", children: children.map(element) } as unknown as Element;
}

const name = (element: Element | null) => (element as unknown as { name: string } | null)?.name ?? null;

describe("below", () => {
  vi.stubGlobal("getComputedStyle", (element: { style: object }) => element.style);

  // Needs a look, Recent changes, a section after it: 32 px apart, as the board's column lays them out.
  const board = [
    { name: "attention", top: 100, height: 300 },
    { name: "feed", top: 432, height: 200, feed: true },
    { name: "next", top: 664, height: 300 },
  ];

  it("takes the first child that starts below the finger", () => {
    expect(name(below(column(board), 50))).toBe("attention");
    expect(name(below(column(board), 500))).toBe("next");
  });

  it("holds nothing in the gap above Recent changes, and does not skip past the feed to the section after it", () => {
    const flex = column(board);
    expect(below(flex, 416)).toBe(flex);
  });

  it("holds nothing when what follows the finger holds the feed", () => {
    const flex = column([
      { name: "attention", top: 100, height: 300 },
      { name: "wrapper", top: 432, height: 500, holdsFeed: true },
    ]);
    expect(below(flex, 416)).toBe(flex);
  });

  it("holds the section after the feed when the finger is in the gap below it", () => {
    expect(name(below(column(board), 648))).toBe("next");
  });

  it("holds the feed's neighbour above it, in the gap above a card that is not the feed", () => {
    const flex = column([
      { name: "note", top: 100, height: 40 },
      { name: "attention", top: 172, height: 300 },
      { name: "feed", top: 504, height: 200, feed: true },
    ]);
    expect(name(below(flex, 156))).toBe("attention");
  });

  it("passes over a child with no box and one that is fixed or sticky", () => {
    const flex = column([
      { name: "placeholder", top: 200, height: 0 },
      { name: "bar", top: 210, height: 40, position: "fixed" },
      { name: "pinned", top: 220, height: 40, position: "sticky" },
      { name: "card", top: 232, height: 300 },
    ]);
    expect(name(below(flex, 190))).toBe("card");
  });

  it("finds nothing when the finger is below every child", () => {
    expect(below(column(board), 2_000)).toBeNull();
  });
});
