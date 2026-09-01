import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";

// Setup files run outside per-test-file storage isolation and may run
// multiple times; applyD1Migrations() only applies unapplied migrations, so
// calling it here is safe.
const e = env as unknown as Env & { TEST_MIGRATIONS: unknown };
await applyD1Migrations(e.DB, e.TEST_MIGRATIONS as Parameters<typeof applyD1Migrations>[1]);
