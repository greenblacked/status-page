import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge } from "./badge";
import { Button } from "./button";
import { Input } from "./input";
import { Segmented } from "./segmented";
import { Skeleton } from "./skeleton";
import { Switch } from "./switch";
import { Tag } from "./tag";

const noop = () => {};

describe("Segmented", () => {
  const options = [
    { value: "all", label: "All", count: 14 },
    { value: "cloud", label: "Cloud", count: 2 },
    { value: "issues", label: "Issues", count: 3, countOnPhone: true },
  ] as const;
  const html = renderToStaticMarkup(
    createElement(Segmented<"all" | "cloud" | "issues">, {
      label: "Category",
      options,
      value: "cloud",
      onChange: noop,
    }),
  );

  it("is a named group of buttons with aria-pressed, on the control track", () => {
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Category"');
    expect(html).toContain("control");
    expect(html.match(/<button[^>]*aria-pressed="(true|false)"/g)).toHaveLength(3);
  });

  it("presses exactly one, and lifts it to the card", () => {
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    const pressed = html.match(/<button[^>]*aria-pressed="true"[^>]*>/)?.[0] ?? "";
    expect(pressed).toContain("bg-card");
    expect(pressed).toContain("font-semibold");
    expect(pressed).toContain("rounded-thumb");
  });

  it("shows counts from the desktop breakpoint, and on a phone only where asked", () => {
    expect(html).toMatch(/<span class="font-normal text-subtle max-md:hidden">14<\/span>/);
    expect(html).toMatch(/<span class="font-normal text-subtle max-md:hidden">2<\/span>/);
    expect(html).toMatch(/<span class="font-normal text-subtle">3<\/span>/);
  });

  it("leaves the count out when there is none", () => {
    const plain = renderToStaticMarkup(
      createElement(Segmented<"a">, {
        label: "One",
        options: [{ value: "a", label: "Only" }],
        value: "a",
        onChange: noop,
      }),
    );
    expect(plain).toContain(">Only</button>");
  });
});

describe("Tag", () => {
  it("is a tiny label on an inset", () => {
    const html = renderToStaticMarkup(createElement(Tag, null, "New release"));
    expect(html).toContain("inset");
    expect(html).toContain("text-footnote");
    expect(html).toContain("rounded-sm");
    expect(html).toContain(">New release<");
  });
});

describe("Badge (transitional)", () => {
  it("still tells a status by its word, on an inset, with no capitals", () => {
    const html = renderToStaticMarkup(createElement(Badge, { tone: "outage" }, "Outage"));
    expect(html).toContain("text-down");
    expect(html).toContain("inset");
    expect(html).not.toContain("uppercase");
  });
});

describe("Button", () => {
  it("has a control variant that lifts to the card when pressed", () => {
    const html = renderToStaticMarkup(createElement(Button, { variant: "control", "aria-pressed": true }, "Starred"));
    expect(html).toContain("control");
    expect(html).toContain("aria-pressed:bg-card");
    expect(html).toContain('type="button"');
    expect(html).toContain("rounded-md");
  });

  it("keeps outline as the control's old name, and a ghost", () => {
    expect(renderToStaticMarkup(createElement(Button, { variant: "outline" }, "x"))).toContain("control");
    expect(renderToStaticMarkup(createElement(Button, { variant: "ghost" }, "x"))).toContain("hover:bg-inset");
  });

  it("is 44px for a finger", () => {
    expect(renderToStaticMarkup(createElement(Button, { size: "icon" }, "x"))).toContain("size-11");
    expect(renderToStaticMarkup(createElement(Button, { size: "sm" }, "x"))).toContain("pointer-coarse:h-11");
  });
});

describe("Input", () => {
  it("is a control field", () => {
    const html = renderToStaticMarkup(createElement(Input, { type: "search", placeholder: "Search…" }));
    expect(html).toContain("control");
    expect(html).toContain("h-11");
    expect(html).toContain("rounded-md");
    expect(html).toContain("focus-ring");
  });
});

describe("Switch", () => {
  const render = (checked: boolean) =>
    renderToStaticMarkup(createElement(Switch, { checked, onCheckedChange: noop, labelledBy: "l", describedBy: "d" }));

  it("says On or Off in the board's sans, not in capitals", () => {
    expect(render(true)).toContain(">On<");
    expect(render(false)).toContain(">Off<");
    expect(render(true)).toContain("text-footnote");
    expect(render(true)).not.toContain("uppercase");
    expect(render(true)).not.toContain("font-mono");
  });

  it("is a labelled, described switch", () => {
    const html = render(true);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-labelledby="l"');
    expect(html).toContain('aria-describedby="d"');
    expect(render(false)).toContain('aria-checked="false"');
  });
});

describe("Skeleton", () => {
  it("is still", () => {
    const html = renderToStaticMarkup(createElement(Skeleton, { className: "h-56" }));
    expect(html).not.toContain("animate-pulse");
    expect(html).toContain("bg-inset");
    expect(html).toContain("h-56");
  });
});
