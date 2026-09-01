import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Fixed asset filenames: the Worker-rendered shells (/:slug, /u/:slug)
 * reference /assets/app.js directly instead of importing a build manifest.
 * Cache freshness is handled by short max-age in web/public/_headers.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // `npm run dev:worker` must be running on 8787 for API/tiles/privacy.
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/tiles": "http://127.0.0.1:8787",
      "/privacy": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
        manualChunks(id: string) {
          return id.includes("maplibre-gl") ? "maplibre" : undefined;
        },
      },
    },
  },
});
