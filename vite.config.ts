import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
  },
  plugins: [
    tailwindcss(),
    ...(cloudflareTarget ? [cloudflare({ viteEnvironment: { name: "ssr" } })] : []),
    tanstackStart(),
    viteReact(),
  ],
});
