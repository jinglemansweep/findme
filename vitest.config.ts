import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

// The migration list is read in Node and exposed to the worker context as a
// test-only binding; test/setup.ts applies it to the local D1 database.
const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Never open a remote-proxy session for the `remote: true` bindings in
      // wrangler.jsonc — tests run fully locally (TILES is overridden below).
      remoteBindings: false,
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
        // Override the `remote: true` R2 binding with a local in-memory
        // bucket so tests never touch a real one.
        r2Buckets: ["TILES"],
        // Required for `exports.default.scheduled()` in cron tests.
        compatibilityFlags: ["service_binding_extra_handlers"],
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
