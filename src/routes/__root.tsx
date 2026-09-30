import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useState } from "react";
import { ALERTS_BOOT_SCRIPT } from "@/lib/status/alerts-support";
import { APP_NAME } from "@/lib/status/catalog";
import { REDUCE_GLASS_BOOT_SCRIPT } from "@/lib/status/glass";
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
    // suppressHydrationWarning, <html> only: the Reduce glass boot script
    // (scripts, below) may add data-reduce-transparency and data-alerts to this element
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
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f4f2ec" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#05070d" />
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

const DESCRIPTION =
  "Live status board for GCP, AWS, Steam, CS2 Europe, Epic, Fortnite, Spotify, Apple, Android, Grok, ChatGPT, Claude, MikroTik RouterOS, and Apple OS.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      // viewport-fit=cover lets the page run under the notch and the home
      // indicator, so env(safe-area-inset-*) has values to keep content out
      // of them; Safari 26 also needs it to tint its bottom toolbar.
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: APP_NAME },
      { name: "description", content: DESCRIPTION },
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
      { property: "og:description", content: DESCRIPTION },
      { name: "twitter:card", content: "summary" },
      // og:image and og:url are deliberately absent: scrapers resolve them
      // against nothing, so they need the deployed origin spelled out, and
      // this repository does not record one yet. Add them, pointing at the
      // existing public/og.jpg (1200x630), once the board has a canonical URL.
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      // 180x180, square and unrounded: iOS applies its own corner mask.
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "alternate", type: "application/atom+xml", title: `${APP_NAME} incidents`, href: "/feed.xml" },
      { rel: "stylesheet", href: appCss },
      // After appCss, so its rules win ties on equal specificity.
      { rel: "stylesheet", href: appleCss },
    ],
    // Applies a stored Reduce glass choice, and marks a browser that cannot
    // show page alerts, before the first paint.
    scripts: [{ children: REDUCE_GLASS_BOOT_SCRIPT }, { children: ALERTS_BOOT_SCRIPT }],
  }),
  component: RootDocument,
});
