import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dateline, LocalTime } from "./local-time";

const at = Date.parse("2026-09-30T10:04:00Z");

// The server render is what these check: renderToStaticMarkup never hydrates, so it is the text the
// server sends and the hydrating render must repeat.
describe("LocalTime on the server", () => {
  it("prints UTC, with the whole moment in UTC as its title and an ISO dateTime", () => {
    const html = renderToStaticMarkup(createElement(LocalTime, { at }));
    expect(html).toBe('<time dateTime="2026-09-30T10:04:00.000Z" title="30 Sep 2026 10:04 UTC">10:04\u202fUTC</time>');
  });

  it("puts the date first for another day than the reference, and never for a slot", () => {
    const yesterday = Date.parse("2026-09-29T09:00:00Z");
    expect(renderToStaticMarkup(createElement(LocalTime, { at: yesterday, reference: at }))).toContain(
      ">29 Sep 09:00\u202fUTC<",
    );
    expect(renderToStaticMarkup(createElement(LocalTime, { at: yesterday, reference: at, format: "slot" }))).toContain(
      ">09:00\u202fUTC<",
    );
  });

  it("prints a date for the dateline", () => {
    const html = renderToStaticMarkup(createElement(Dateline, { generatedAt: "2026-09-30T10:04:00.000Z" }));
    expect(html).toContain(">Wednesday 30 September<");
    expect(html).toContain('title="30 Sep 2026 10:04 UTC"');
    expect(renderToStaticMarkup(createElement(Dateline, { generatedAt: at }))).toBe(html);
  });

  it("renders nothing for a moment that is not one", () => {
    expect(renderToStaticMarkup(createElement(LocalTime, { at: Number.NaN }))).toBe("");
    expect(renderToStaticMarkup(createElement(Dateline, { generatedAt: "not a date" }))).toBe("");
  });

  it("falls back to its own moment when the reference is not one", () => {
    expect(renderToStaticMarkup(createElement(LocalTime, { at, reference: Number.NaN }))).toContain(">10:04\u202fUTC<");
  });

  it("passes a class through", () => {
    expect(renderToStaticMarkup(createElement(LocalTime, { at, className: "text-subtle" }))).toContain(
      'class="text-subtle"',
    );
  });
});
