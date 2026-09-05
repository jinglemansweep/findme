# AGENTS.md

Anonymous, no-login, expiring location sharing on Cloudflare Workers. A pin's
precise position lives only in its `LivePin` Durable Object; D1 holds metadata
(slug, secret hash, label, expiry) and never coordinates.

## Commands

```bash
npm install
npm run dev:worker     # Worker on :8787 (D1 + DOs local; TILES reads remote R2)
npm run dev:web        # Vite on :5173, proxying /api, /tiles, /privacy
npm test               # builds the SPA first, then runs vitest against real workerd
npm run test:e2e       # Playwright: boots wrangler dev locally (wrangler.ci.jsonc,
                       # remote bindings stripped — no Cloudflare credentials)
npm run typecheck      # worker + web
npm run migrate:local  # apply D1 migrations to the local Miniflare database
```

Deploys are `npm run deploy:staging|production` — build → migrate → deploy, in
that order, never reordered (docs/RUNBOOK.md §2). Never `wrangler deploy`
without `--env`: the top-level wrangler config is a template with a placeholder
D1 id. Secrets (`IP_SALT`, `TURNSTILE_SECRET`) are set manually per environment
with `wrangler secret put`, never committed.

## Layout

- `src/` Worker: router (`index.ts`), API (`api/`), HTML shells (`shells/`),
  `LivePin` + `EmailLimiter` DOs, PMTiles range proxy (`tiles/`), one-shot
  email, cron sweep.
- `web/` React + Vite + MapLibre SPA, built into `web/dist` and served as
  Worker assets; the shells boot it via a JSON script tag.
- `migrations/` D1 migrations — forward-only, never edit an applied file.
- `test/` workerd-backed vitest suite; `e2e/` Playwright specs driven against
  a local `wrangler dev`; `docs/` RUNBOOK / TILES / MIGRATIONS.

## Invariants — check before changing anything

- **Position never enters D1.** The `pins` table stores no lat/lng/email; the
  DO alone serves positions (`GET /api/pins/:slug/position` must not read D1).
- **Slug entropy is the security model**: 12 chars Crockford base32 (~60 bits),
  no discovery surface. Don't shorten `SLUG_LENGTH` without a deliberate review.
- **The control secret travels only in the URL fragment** (`#s_…`), is stored
  hashed (SHA-256) in D1, and compared constant-time. Never place it in a query
  string, a response body, server HTML, or a share sheet — only the public link
  is shareable.
- **Escape user text everywhere** (`escapeHtml`, `bootJson`): labels render
  into server HTML and the boot JSON tag.
- **No inline scripts** (CSP forbids them). Asset filenames are fixed
  (`/assets/app.js`) because the shells reference them directly. Keep the CSP
  in `src/lib/http.ts` and `web/public/_headers` in sync.
- **DO storage shapes are versioned** (`v: 1`) and read tolerantly — live
  objects outlive deploys by up to 7 days (docs/MIGRATIONS.md §6).
- **Write ordering**: D1 row before DO on create; DO before D1 when reducing
  access (stop, shorten); D1 before DO when extending.
- **Named wrangler environments restate every binding** — vars, DOs, R2,
  ratelimits and send_email are not inherited; only D1 ids differ. CI dry-runs
  assert the `LIVE_PIN` binding survives.

## Conventions

- Comments explain why, not what; cite `docs/*.md §N` for procedures.
- Tests need a distinct `CF-Connecting-IP` per request (per-IP rate limits);
  the suite runs fully local (`remoteBindings: false` in vitest.config.ts).
- Licence is GPL-3.0-or-later.
