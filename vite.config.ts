import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// DEPLOY_TARGET=cloudflare builds the server for Cloudflare Workers
// (wrangler.jsonc). Without it the build stays a plain Fetch-style handler,
// which `npm run preview` and CI's smoke test run on Node.
const cloudflareTarget = process.env.DEPLOY_TARGET === "cloudflare";

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: {
    tsconfigPaths: true,
    alias: cloudflareTarget
      ? [
          // The board reads a KV snapshot a Cron Trigger keeps fresh
          // (src/lib/status/board.cloudflare.ts) instead of collecting
          // vendors itself on every request (src/lib/status/board.ts). Every
          // route imports "@/lib/status/board" either way; this is the only
          // thing that changes which one they get, so the Node build never
          // resolves the Workers-only file. The regex matches the bare
          // specifier only, not "@/lib/status/board-view" or similar.
          { find: /^@\/lib\/status\/board$/, replacement: path.resolve(dirname, "src/lib/status/board.cloudflare.ts") },
        ]
      : [],
  },
  plugins: [
    tailwindcss(),
    ...(cloudflareTarget ? [cloudflare({ viteEnvironment: { name: "ssr" } })] : []),
    // The Cloudflare build's own entry (env bindings, the Cron Trigger's
    // `scheduled` export) is wrangler.jsonc's `main`, which
    // @cloudflare/vite-plugin resolves on its own outside of TanStack
    // Start's usual entry system; there is nothing to configure here.
    tanstackStart(),
    viteReact(),
  ],
});
