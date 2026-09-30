import { createFileRoute } from "@tanstack/react-router";
import { isNoindex, robotsTxt } from "@/lib/robots";
import { findCloudflareContext } from "@/lib/status/cloudflare-context";

// GET /robots.txt: "Disallow: /" on a deployment that must not be indexed
// (the stage preview, whose wrangler.jsonc previews.vars sets ROBOTS=noindex), and
// "Allow: /" everywhere else. On the Node build there is no Workers
// context, so it always allows.
export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(robotsTxt(isNoindex(findCloudflareContext()?.env.ROBOTS)), {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
        }),
    },
  },
});
