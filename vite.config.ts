import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const cloudflareTarget = process.env.DEPLOY_TARGET === "cloudflare";

export default defineConfig({
  build: {
    // The default inlines a file under 4 KB, which would turn the 3.9 KB hand
    // into a data: URL, and the Content-Security-Policy (font-src 'self')
    // blocks those. Fonts stay files, with a hashed name under /assets/.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
  },
  server: { port: 3000 },
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    ...(cloudflareTarget ? [cloudflare({ viteEnvironment: { name: "ssr" } })] : []),
    tanstackStart(),
    viteReact(),
  ],
});
