import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const cloudflareTarget = process.env.DEPLOY_TARGET === "cloudflare";

export default defineConfig({
  server: { port: 3000 },
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    ...(cloudflareTarget ? [cloudflare({ viteEnvironment: { name: "ssr" } })] : []),
    tanstackStart(),
    viteReact(),
  ],
});
