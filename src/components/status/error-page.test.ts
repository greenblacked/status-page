import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrorPage, MessageShell } from "./error-page";

// The props type requires children; createElement's own children argument does not satisfy it.
const shell = (title: string, children: string) => createElement(MessageShell, { title, children });

describe("MessageShell", () => {
  it("is a main landmark with the wordmark row and one headline in the board's type", () => {
    const html = renderToStaticMarkup(shell("Nothing here.", "body"));
    expect(html).toMatch(/^<main /);
    expect(html).toContain('<h1 class="mt-12 text-headline text-balance md:text-display">Nothing here.</h1>');
    expect(html).toContain("szolotov.com");
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("uses tokens only: no raw colours, no fonts of its own, no hand note", () => {
    const html = renderToStaticMarkup(shell("x", "y"));
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|font-hand|font-mono|font-serif/i);
  });
});

describe("ErrorPage", () => {
  const html = renderToStaticMarkup(createElement(ErrorPage, { error: new Error("boom") }));

  it("apologises in the owner's voice and offers two ways out", () => {
    expect(html).toContain("Something broke on my side.");
    expect(html).toContain("Reload the page, or");
    expect(html).toContain('href="/"');
    expect(html).toContain("go back to the board");
    expect(html).toMatch(/<button[^>]*>Reload<\/button>/);
  });

  it("never shows the error to the visitor: it goes to the console only", () => {
    expect(html).not.toContain("boom");
  });
});
