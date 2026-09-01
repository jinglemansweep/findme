import type { Env } from "../env";

export function json(data: unknown, init: ResponseInit = {}): Response {
  return withSecurityHeaders(
    new Response(JSON.stringify(data), {
      ...init,
      headers: { "Content-Type": "application/json; charset=utf-8", ...init.headers },
    }),
  );
}

export function errorJson(status: number, error: string): Response {
  return json({ error }, { status });
}

/**
 * The SPA boots from a JSON script tag, so executable inline scripts are not
 * needed and the CSP can be strict. MapLibre spins up workers from blob URLs
 * and Turnstile needs its origin.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  // tiles.openfreemap.org: the fallback basemap used until the PMTiles
  // archive is in R2 (style JSON, tiles and glyphs are all fetched).
  "connect-src 'self' https://challenges.cloudflare.com https://tiles.openfreemap.org",
  // maplibre v6 workers load from a same-origin module script; blob covers
  // its fallback path.
  "worker-src 'self' blob:",
  "frame-src https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function withSecurityHeaders(
  response: Response,
  opts: { referrerPolicy?: string; csp?: boolean } = {},
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", opts.referrerPolicy ?? "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "geolocation=(self)");
  if (opts.csp !== false && !headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", CSP);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function html(
  body: string,
  opts: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...opts.headers,
  };
  return withSecurityHeaders(new Response(body, { status: opts.status ?? 200, headers }), {
    referrerPolicy: headers["Referrer-Policy"],
  });
}

/** Truthy when the KILL_SWITCH var disables writes (PLAN.md §17). */
export function killSwitchOn(env: Env): boolean {
  const v = env.KILL_SWITCH?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}
