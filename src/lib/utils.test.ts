import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("joins classes and drops falsy ones", () => {
    expect(cn("a", false, null, undefined, "b", { c: true, d: false })).toBe("a b c");
  });

  it("lets a later utility of the same kind win", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-muted", "text-fg")).toBe("text-fg");
    expect(cn("rounded-md", "rounded-lg")).toBe("rounded-lg");
  });

  it("keeps a type step beside a text colour: they are different things", () => {
    expect(cn("text-caption", "text-muted")).toBe("text-caption text-muted");
    expect(cn("text-muted", "text-caption")).toBe("text-muted text-caption");
    for (const step of ["display", "headline", "card", "row", "body", "caption", "footnote", "hand", "hand-lg"]) {
      expect(cn(`text-${step}`, "text-fg")).toBe(`text-${step} text-fg`);
    }
  });

  it("replaces one type step with another", () => {
    expect(cn("text-body", "text-caption")).toBe("text-caption");
    expect(cn("text-headline", "md:text-display")).toBe("text-headline md:text-display");
    expect(cn("text-hand", "text-hand-lg")).toBe("text-hand-lg");
  });

  it("knows the board's own radii", () => {
    expect(cn("rounded-md", "rounded-thumb")).toBe("rounded-thumb");
    expect(cn("rounded-bar", "rounded-lg")).toBe("rounded-lg");
  });
});
