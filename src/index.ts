import PRIVACY_MD from "../PRIVACY.md";
import type { Env } from "./env";
import {
  createPin,
  findPin,
  getPosition,
  getMeta,
  getPinStub,
  patchPin,
  rotateSecret,
  setPosition,
  stopPin,
} from "./api/pins";
import { handleConfig } from "./api/config";
import { runExpirySweep } from "./cron";
import { LivePin } from "./do/LivePin";
import { EmailLimiter } from "./do/EmailLimiter";
import { errorJson, html, withSecurityHeaders } from "./lib/http";
import { ipHash, rateLimitOk } from "./lib/ratelimit";
import { isSlug } from "./lib/slug";
import { controlShell } from "./shells/control";
import { privacyShell } from "./shells/privacy";
import { publicShell } from "./shells/public";
import { handleTiles } from "./tiles/routes";

export { EmailLimiter, LivePin };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path.startsWith("/api/")) return await handleApi(request, env, url);

      if (path === "/tiles" || path.startsWith("/tiles/")) {
        return withSecurityHeaders(await handleTiles(request, env, url), { csp: false });
      }

      if (path === "/privacy" && (request.method === "GET" || request.method === "HEAD")) {
        const body = privacyShell(PRIVACY_MD, footerFrom(env));
        return html(body, {
          headers: {
            "Cache-Control": "public, max-age=3600",
            "X-Robots-Tag": "noindex",
          },
        });
      }

      if (path.startsWith("/u/")) {
        if (request.method !== "GET" && request.method !== "HEAD") return errorJson(405, "method not allowed");
        return await serveControlShell(request, env, url, path.slice(3));
      }

      const maybeSlug = path.slice(1);
      if (request.method === "GET" && isSlug(maybeSlug)) {
        return await servePublicShell(request, env, url, maybeSlug);
      }

      // Everything else (/, /assets/*, /favicon.svg, /robots.txt, …) belongs
      // to the static asset layer; unmatched GETs fall back to the SPA.
      if (request.method === "GET" || request.method === "HEAD") {
        return env.ASSETS.fetch(request);
      }
      return errorJson(404, "not found");
    } catch (err) {
      console.error("unhandled error", err instanceof Error ? err.stack ?? err.message : err);
      return errorJson(500, "internal error");
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runExpirySweep(env);
  },
} satisfies ExportedHandler<Env>;

function footerFrom(env: Env) {
  return { abuseEmail: env.ABUSE_EMAIL ?? null, privacyEmail: env.PRIVACY_EMAIL ?? null };
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const segments = url.pathname.slice("/api/".length).split("/");

  if (segments[0] === "config" && request.method === "GET") {
    return handleConfig(env);
  }

  if (segments[0] === "pins") {
    if (segments.length === 1 && request.method === "POST") {
      return createPin(request, env, url);
    }
    if (segments.length >= 2) {
      const slug = segments[1];
      if (segments.length === 2 && request.method === "GET") {
        return getMeta(request, env, slug);
      }
      if (segments.length === 3 && segments[2] === "position") {
        if (request.method === "GET") return getPosition(env, slug);
        if (request.method === "POST") return setPosition(request, env, slug);
      }
      if (segments.length === 2 && request.method === "PATCH") {
        return patchPin(request, env, slug);
      }
      if (segments.length === 2 && request.method === "DELETE") {
        return stopPin(request, env, slug);
      }
      if (segments.length === 3 && segments[2] === "rotate" && request.method === "POST") {
        return rotateSecret(request, env, url, slug);
      }
    }
  }

  return errorJson(404, "not found");
}

/**
 * Public shell. This is a page view, not the poll path, so a D1 read here is
 * fine (§8) — and it is where the lazy self-heal happens: if D1 says the pin
 * is active but the DO has no expiry (creation's DO step failed), re-issue
 * configure() from the row.
 */
async function servePublicShell(request: Request, env: Env, url: URL, slug: string): Promise<Response> {
  if (!(await slugLookupAllowed(request, env))) return errorJson(429, "too many requests");

  const row = await findPin(env, slug);

  const ended = !row || row.status !== "active" || row.expires_at <= Date.now();
  if (row && !ended) {
    try {
      await getPinStub(env, slug, request).ensureConfigured(row.expires_at);
    } catch (err) {
      console.error("self-heal configure failed", err instanceof Error ? err.message : err);
    }
  }

  const body = publicShell({
    slug,
    row,
    ended,
    origin: url.origin,
    footer: footerFrom(env),
  });
  const status = !row ? 404 : ended ? 410 : 200;
  return html(body, {
    status,
    headers: {
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}

/**
 * Control shell. The fragment never reaches the server, so this is identical
 * HTML for anyone holding the slug: no label, no state beyond active/ended.
 */
async function serveControlShell(request: Request, env: Env, url: URL, slug: string): Promise<Response> {
  if (!isSlug(slug)) {
    return html(publicShell({ slug, row: null, ended: false, origin: url.origin, footer: footerFrom(env) }), {
      status: 404,
      headers: { "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" },
    });
  }
  if (!(await slugLookupAllowed(request, env))) return errorJson(429, "too many requests");

  const row = await findPin(env, slug);
  if (!row) {
    return html(publicShell({ slug, row: null, ended: false, origin: url.origin, footer: footerFrom(env) }), {
      status: 404,
      headers: { "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" },
    });
  }

  const ended = row.status !== "active" || row.expires_at <= Date.now();
  const body = controlShell({ slug, ended, footer: footerFrom(env) });
  return html(body, {
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      // A control URL must never leak via Referer.
      "Referrer-Policy": "no-referrer",
    },
  });
}

async function slugLookupAllowed(request: Request, env: Env): Promise<boolean> {
  return rateLimitOk(env.SLUG_LOOKUPS, `lookup:${await ipHash(env, request)}`);
}
