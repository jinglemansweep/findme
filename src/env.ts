import type { EmailLimiter } from "./do/EmailLimiter";
import type { LivePin } from "./do/LivePin";

export interface Env {
  DB: D1Database;
  TILES: R2Bucket;
  ASSETS: Fetcher;

  LIVE_PIN: DurableObjectNamespace<LivePin>;
  EMAIL_LIMITER: DurableObjectNamespace<EmailLimiter>;

  /** Native rate limiter (per-colo approximate counting). */
  SLUG_LOOKUPS: RateLimit;
  PIN_CREATES: RateLimit;

  /** Native email binding; absent in local dev unless "remote": true. */
  EMAIL?: SendEmail;

  // vars
  PMTILES_KEY?: string;
  TILES_MAXZOOM?: string;
  MAP_BOUNDS?: string;
  ABUSE_EMAIL?: string;
  PRIVACY_EMAIL?: string;
  TURNSTILE_SITE_KEY?: string;
  KILL_SWITCH?: string;
  /** Set (e.g. "beta") on non-production environments — marks every HTML
   *  response's title and header so it can't be mistaken for production. */
  ENV_LABEL?: string;

  // secrets
  IP_SALT?: string;
  TURNSTILE_SECRET?: string;

  /** Test-only: D1 migration list read by vitest setup. */
  TEST_MIGRATIONS?: readonly unknown[];
}
