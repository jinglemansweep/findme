import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/**
 * One LivePin per pin. It holds the only copy of the precise position and
 * wipes itself on alarm. D1 decides who may write; this object decides what
 * may be served (PLAN.md §7).
 *
 * Storage shape is versioned from release one (docs/MIGRATIONS.md §6) —
 * objects created under an old shape live on for up to 7 days after a deploy.
 */
interface StoredPosition {
  v: 1;
  lat: number;
  lng: number;
  accuracy: number | null;
  at: number;
}

interface StoredExpiry {
  v: 1;
  at: number;
}

export type PositionResult =
  | { gone: true }
  | { pending: true }
  | {
      lat: number;
      lng: number;
      accuracy: number | null;
      at: number;
      /** Server clock at response time; clients compute ages from this. */
      now: number;
      /** Current expiry — lets viewers follow an extension without a reload. */
      expiresAt: number;
    };

export class LivePin extends DurableObject<Env> {
  /**
   * Viewer path. No D1, no auth. Absence of `exp` means gone.
   *
   * Expiry is enforced on read, not only by the alarm: alarms fire at or
   * after their scheduled time, so without this check a delayed wipe could
   * keep serving a position past its expiry.
   */
  async getPosition(): Promise<PositionResult> {
    const exp = await this.getExpiry();
    if (!exp || Date.now() >= exp) return { gone: true };
    const pos = (await this.ctx.storage.get<StoredPosition>("pos")) ?? null;
    if (!pos || pos.v !== 1) return { pending: true };
    return { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, at: pos.at, now: Date.now(), expiresAt: exp };
  }

  /** Called only after the Worker has authorised the write against D1. */
  async setPosition(input: { lat: number; lng: number; accuracy: number | null }): Promise<
    { ok: true; at: number } | { gone: true }
  > {
    const exp = await this.getExpiry();
    if (!exp || Date.now() >= exp) return { gone: true };
    const pos: StoredPosition = {
      v: 1,
      lat: input.lat,
      lng: input.lng,
      accuracy: input.accuracy,
      at: Date.now(),
    };
    await this.ctx.storage.put("pos", pos);
    return { ok: true, at: pos.at };
  }

  async configure(expiresAtMs: number): Promise<{ ok: true }> {
    await this.ctx.storage.put<StoredExpiry>("exp", { v: 1, at: expiresAtMs });
    // A DO has one alarm at a time; setAlarm overwrites. Each call is billed
    // as one row written (§8), so never call this on the hot path.
    await this.ctx.storage.setAlarm(expiresAtMs);
    return { ok: true };
  }

  /**
   * Self-healing path (§7): if D1 says the pin is active but this object has
   * no `exp` (D1 row written, DO init failed), re-issue the configuration
   * from the D1 row — lazily, on first view.
   */
  async ensureConfigured(expiresAtMs: number): Promise<{ configured: boolean }> {
    const exp = await this.getExpiry();
    if (exp) return { configured: false };
    await this.configure(expiresAtMs);
    return { configured: true };
  }

  async stop(): Promise<{ ok: true }> {
    await this.ctx.storage.deleteAll();
    // deleteAll() does not clear alarms.
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  /**
   * Guaranteed at-least-once execution and retried on uncaught exception —
   * the handler must be idempotent. deleteAll() is naturally safe to repeat.
   */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  private async getExpiry(): Promise<number | null> {
    const exp = (await this.ctx.storage.get<StoredExpiry>("exp")) ?? null;
    return exp && exp.v === 1 ? exp.at : null;
  }
}
