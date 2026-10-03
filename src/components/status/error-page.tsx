import type { ErrorComponentProps } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { WORDMARK } from "@/lib/status/catalog";

/**
 * The frame the pages off the happy path share: the wordmark row and one
 * headline, in the board's own type. Tokens only, so both appearances and the
 * forced-colours and print rules apply to it as they do to the board. No hand
 * note here: "all quiet" is for when everything is up.
 */
export function MessageShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="page-gutter mx-auto max-w-[62rem] pt-6 pb-18 md:pt-12">
      <p data-testid="wordmark" className="text-center text-row">
        {WORDMARK}
      </p>
      <h1 className="mt-12 text-headline text-balance md:text-display">{title}</h1>
      <div className="mt-2 text-body text-muted">{children}</div>
    </main>
  );
}

/**
 * What a render error shows instead of the router's unbranded default. The
 * error itself goes to the console only: a stack trace is no use to a visitor,
 * and a message from inside the app must not be shown as the page's own words.
 */
export function ErrorPage({ error }: Pick<ErrorComponentProps, "error">) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <MessageShell title="Something broke on my side.">
      <p>
        Reload the page, or{" "}
        <a className="focus-ring rounded-sm text-accent underline underline-offset-4" href="/">
          go back to the board
        </a>
        .
      </p>
      <Button variant="control" className="mt-6" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </MessageShell>
  );
}
