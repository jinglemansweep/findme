import type { Env } from "./env";

/**
 * Cron sweep (every 10 min): remove expired rows — both drained tombstones
 * (status='stopped') and active rows past their expiry. The DO alarm wipes
 * the position; this reclaims the D1 row so the slug can eventually read 404
 * instead of 410.
 *
 * Batched: D1 bills on rows scanned, and a pathological backlog should not
 * pin the invocation against limits.cpu_ms.
 */
export async function runExpirySweep(env: Env): Promise<void> {
  const now = Date.now();
  const BATCH = 500;
  for (let i = 0; i < 40; i++) {
    const result = await env.DB.prepare(
      "DELETE FROM pins WHERE slug IN (SELECT slug FROM pins WHERE expires_at < ?1 LIMIT ?2)",
    )
      .bind(now, BATCH)
      .run();
    const deleted = result.meta?.changes ?? 0;
    if (deleted < BATCH) break;
  }
}
