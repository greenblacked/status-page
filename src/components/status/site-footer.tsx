import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The page's colophon: a real <footer> (the contentinfo landmark), a sibling
 * after <main>, never inside it. Two lines of words and one of credit, in the
 * owner's voice. Nothing here explains how the machinery works.
 *
 *   Not affiliated with any of these vendors. I only read their public status pages.
 *   Source on GitHub · MIT License · JSON · Atom feed · Badges · Settings (press ?)
 *   Built with TanStack Start on Cloudflare Workers.               Made by greenblacked.
 */
const LINK =
  "focus-ring pressable inline-block rounded-sm underline decoration-hairline underline-offset-4 hover:text-fg pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center pointer-coarse:justify-center";

function Link({
  href,
  external,
  rel,
  children,
}: {
  href: string;
  external?: boolean;
  rel?: string;
  children: ReactNode;
}) {
  return (
    <a className={LINK} href={href} {...(external ? { target: "_blank", rel: rel ?? "noopener noreferrer" } : {})}>
      {children}
      {external ? <ArrowUpRight aria-hidden="true" className="ml-0.5 inline size-3.5 align-[-2px]" /> : null}
    </a>
  );
}

const SEPARATOR = (
  <span aria-hidden="true" className="px-1.5">
    ·
  </span>
);

export function SiteFooter({
  onOpenSettings,
  singleKey,
  className,
}: {
  onOpenSettings: () => void;
  /** Whether the single-key shortcuts are on; when they are, the button says which key opens the same thing. */
  singleKey: boolean;
  className?: string;
}) {
  return (
    <footer className={cn("flex flex-col gap-y-1 text-caption text-subtle", className)}>
      <div className="flex flex-col gap-x-8 gap-y-1 md:flex-row md:flex-wrap md:items-baseline md:justify-between">
        <p>Not affiliated with any of these vendors. I only read their public status pages.</p>
        <p>
          <Link href="https://github.com/greenblacked/status-page" external>
            Source on GitHub
          </Link>
          {SEPARATOR}
          <Link
            href="https://github.com/greenblacked/status-page/blob/main/LICENSE"
            external
            rel="noopener noreferrer license"
          >
            MIT License
          </Link>
          {SEPARATOR}
          <Link href="/api/status.json">JSON</Link>
          {SEPARATOR}
          <Link href="/feed.xml">Atom feed</Link>
          {SEPARATOR}
          <Link href="/api/badge/board">Badges</Link>
          {SEPARATOR}
          {/*
            On every screen width: with the single-key shortcuts off, ? no
            longer opens the list, and this button is the way back to the
            switches, including on a desktop zoomed to a phone's width, and
            the only way to them on a touch screen.
          */}
          <button type="button" className={LINK} onClick={onOpenSettings}>
            Settings
          </button>
          {singleKey ? (
            <span className="hidden pointer-fine:inline">
              {" "}
              (press <kbd className="rounded-sm border border-hairline px-1 font-sans text-footnote text-muted">?</kbd>)
            </span>
          ) : null}
        </p>
      </div>
      <div className="flex flex-col gap-x-8 gap-y-1 text-footnote md:flex-row md:items-baseline md:justify-between">
        <p>Built with TanStack Start on Cloudflare Workers.</p>
        <p>
          Made by{" "}
          <Link href="https://github.com/greenblacked" external>
            greenblacked
          </Link>
          .
        </p>
      </div>
    </footer>
  );
}
