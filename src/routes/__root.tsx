import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useState } from "react";
import { ALERTS_BOOT_SCRIPT } from "@/lib/status/alerts-support";
import { APPEARANCE_BOOT_SCRIPT } from "@/lib/status/background";
import { APP_NAME } from "@/lib/status/catalog";
import { CANONICAL_URL, OG_IMAGE, SITE_DESCRIPTION } from "@/lib/status/site-meta";
import appleCss from "../apple.css?url";
import appCss from "../styles.css?url";

function RootDocument() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false },
        },
      }),
  );

  return (
    // suppressHydrationWarning, <html> only: the boot scripts (below) may add
    // data-reduce-transparency, data-background and data-alerts to this element
    // before React hydrates it, which the server could not know about.
    <html lang="en" className="antialiased" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/*
          One theme-color per appearance, matching --color-bg. Written here
          because head() keeps a single meta per name. Safari 26 tints its
          toolbars from the page background instead, but a Home Screen
          app's status bar and other browsers still read these.
          public/manifest.webmanifest has only one theme and background
          colour, and no way to vary them by appearance, so it uses the
          dark pair: that matches the icon, and is what a launch screen
          built from the manifest shows before the page paints.
        */}
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f4f1eb" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000" />
      </head>
      <body className="bg-bg font-sans text-fg">
        <QueryClientProvider client={queryClient}>
          <Outlet />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}

export const Route = createRootRoute({
  head: ({ matches }) => ({
    meta: [
      { charSet: "utf-8" },
      // viewport-fit=cover lets the page run under the notch and the home
      // indicator, so env(safe-area-inset-*) has values to keep content out
      // of them; Safari 26 also needs it to tint its bottom toolbar.
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      // A URL that is not on the board says so in the tab too (NotFoundPage draws the page). The router
      // marks the root match `_notFound` for an unmatched URL, on the server and in the browser; its
      // `error` is not set yet when head runs. e2e/not-found.spec.ts holds this to account.
      { title: matches.some((match) => match._notFound) ? `Not found · ${APP_NAME}` : APP_NAME },
      { name: "description", content: SITE_DESCRIPTION },
      { name: "color-scheme", content: "light dark" },
      // Safari turns anything shaped like a phone number, date, address or
      // email into a tappable link, which would rewrite incident text.
      { name: "format-detection", content: "telephone=no, date=no, address=no, email=no" },
      // Add to Home Screen opens the board full screen, under its own name.
      // The default status bar style, not black-translucent: that one
      // always draws white text, which vanishes on the light appearance.
      { name: "apple-mobile-web-app-title", content: APP_NAME },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { property: "og:type", content: "website" },
      { property: "og:title", content: APP_NAME },
      { property: "og:site_name", content: APP_NAME },
      { property: "og:description", content: SITE_DESCRIPTION },
      { property: "og:url", content: CANONICAL_URL },
      // Absolute, because a scraper resolves these against nothing.
      { property: "og:image", content: OG_IMAGE.url },
      { property: "og:image:width", content: String(OG_IMAGE.width) },
      { property: "og:image:height", content: String(OG_IMAGE.height) },
      { property: "og:image:alt", content: OG_IMAGE.alt },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "canonical", href: CANONICAL_URL },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      // 180x180, square and unrounded: iOS applies its own corner mask.
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "alternate", type: "application/atom+xml", title: `${APP_NAME} incidents`, href: "/feed.xml" },
      { rel: "stylesheet", href: appCss },
      // After appCss, so its rules win ties on equal specificity.
      { rel: "stylesheet", href: appleCss },
    ],
    // Applies the stored Reduce glass and Background choices, and marks a
    // browser that cannot show page alerts, before the first paint.
    scripts: [{ children: APPEARANCE_BOOT_SCRIPT }, { children: ALERTS_BOOT_SCRIPT }],
  }),
  component: RootDocument,
});
