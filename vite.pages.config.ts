import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  base: "/website3/",
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  plugins: [react()],
  resolve: { alias: { "@": repositoryRoot } },
  define: {
    __EV_API_BASE__: JSON.stringify("https://ev-subsidy-finder.kwongary1129.chatgpt.site"),
  },
  css: { postcss: repositoryRoot },
  build: {
    outDir: fileURLToPath(new URL("./dist-pages", import.meta.url)),
    emptyOutDir: true,
  },
});
