import type { Env } from "../env";
import { bufferToHex } from "./auth";

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "0.0.0.0";
}

/**
 * IP hashed with a daily-rotating salt held in a Worker secret: abuse control
 * without retaining anything identifying. The day is part of the
 * salt input so counters (and any leakage) reset daily.
 */
export async function ipHash(env: Env, request: Request): Promise<string> {
  const salt = env.IP_SALT ?? "insecure-dev-salt";
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${day}:${clientIp(request)}`),
  );
  return bufferToHex(digest);
}

/**
 * Native ratelimits are approximate and per-colo, which is fine for raising
 * the cost of enumeration. If the binding errors, fail open: an availability
 * regression hurts legitimate users more than a missed abusive client.
 */
export async function rateLimitOk(limiter: RateLimit, key: string): Promise<boolean> {
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch (err) {
    console.error("ratelimit binding failed", err instanceof Error ? err.message : err);
    return true;
  }
}
