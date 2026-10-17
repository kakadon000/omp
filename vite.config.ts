import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// base "./" keeps the build relocatable: works in Tauri (tauri://) and on
// GitHub Pages under /app/ without extra config.
export default defineConfig({
  base: "./",
  plugins: [react()],
  css: { postcss: {} }, // don't inherit stray parent-directory PostCSS configs
  build: {
    outDir: "dist",
    assetsDir: "assets",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        splash: resolve(__dirname, "splash.html"),
      },
    },
  },
});
