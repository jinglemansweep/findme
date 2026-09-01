import { describe, expect, it } from "vitest";
import { exports, env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { bufferToHex, generateSecret } from "../src/lib/auth";
import { generateSlug } from "../src/lib/slug";

const e = env as unknown as Env;

async function insertPin(expiresAt: number, status = "active"): Promise<string> {
  const slug = generateSlug();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(generateSecret()));
  await e.DB.prepare(
    "INSERT INTO pins (slug, secret_hash, label, created_at, expires_at, status) VALUES (?, ?, NULL, ?, ?, ?)",
  )
    .bind(slug, bufferToHex(digest), Date.now(), expiresAt, status)
    .run();
  return slug;
}

describe("cron sweep", () => {
  it("removes expired rows (active and stopped) and keeps live ones", async () => {
    const now = Date.now();
    const expiredActive = await insertPin(now - 60_000, "active");
    const expiredStopped = await insertPin(now - 60_000, "stopped");
    const livePin = await insertPin(now + 3_600_000, "active");
    const liveStopped = await insertPin(now + 3_600_000, "stopped");

    const outcome = await exports.default.scheduled({
      scheduledTime: new Date(now),
      cron: "*/10 * * * *",
    });
    expect(outcome.outcome).toBe("ok");

    const remaining = await e.DB.prepare("SELECT slug FROM pins").all<{ slug: string }>();
    const slugs = remaining.results.map((r) => r.slug);
    expect(slugs).toContain(livePin);
    expect(slugs).toContain(liveStopped);
    expect(slugs).not.toContain(expiredActive);
    expect(slugs).not.toContain(expiredStopped);
  });
});
