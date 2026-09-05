import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/**
 * Exact per-recipient email quota. One object per sha256(recipient), because
 * the native ratelimits binding is per-colo approximate — and per-recipient
 * counting is exactly the case where approximation fails (an attacker routing
 * through several regions to repeatedly mail one victim).
 *
 * The object MUST delete itself: one object per recipient hash, created and
 * never reclaimed, accumulates storage cost for a counter that is meaningless
 * after its window closes. The alarm reclaims it; like LivePin.alarm() the
 * handler is idempotent because alarms retry.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** The email is one-shot at creation; a legitimate recipient needs 1. */
const MAX_PER_WINDOW = 3;

interface StoredWindow {
  v: 1;
  count: number;
  windowEndsAt: number;
}

export class EmailLimiter extends DurableObject<Env> {
  async check(): Promise<{ ok: boolean; remaining: number }> {
    const now = Date.now();
    const win =
      (await this.ctx.storage.get<StoredWindow>("win")) ??
      ({ v: 1, count: 0, windowEndsAt: 0 } satisfies StoredWindow);

    if (win.v !== 1 || now >= win.windowEndsAt) {
      const windowEndsAt = now + WINDOW_MS;
      await this.ctx.storage.put<StoredWindow>("win", {
        v: 1,
        count: 1,
        windowEndsAt,
      });
      await this.ctx.storage.setAlarm(windowEndsAt);
      return { ok: true, remaining: MAX_PER_WINDOW - 1 };
    }

    if (win.count >= MAX_PER_WINDOW) return { ok: false, remaining: 0 };

    await this.ctx.storage.put<StoredWindow>("win", {
      v: 1,
      count: win.count + 1,
      windowEndsAt: win.windowEndsAt,
    });
    return { ok: true, remaining: MAX_PER_WINDOW - win.count - 1 };
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
}
