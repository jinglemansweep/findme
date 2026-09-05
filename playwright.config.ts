import { defineConfig } from "@playwright/test";

/**
 * End-to-end suite against the real Worker: `npm run test:e2e` builds the SPA,
 * applies D1 migrations to local Miniflare state, and boots `wrangler dev`
 * with wrangler.ci.jsonc (remote bindings stripped — no Cloudflare credentials
 * needed). Local runs reuse an already-running dev server on :8787.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:8787",
  },
  webServer: {
    command:
      "node scripts/make-ci-wrangler.mjs && npm run build && npx wrangler d1 migrations apply findme --local --config wrangler.ci.jsonc && npx wrangler dev --config wrangler.ci.jsonc --port 8787 --ip 127.0.0.1",
    url: "http://127.0.0.1:8787/api/config",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: { WRANGLER_SEND_METRICS: "false" },
  },
});
