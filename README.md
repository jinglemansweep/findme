# Find Me

Anonymous, no-login, expiring location sharing on Cloudflare. Drop a pin,
share one URL, and it deletes itself when the TTL runs out. Precise location
lives only inside a per-pin Durable Object and never enters D1.

[![deploy](https://github.com/jinglemansweep/findme/actions/workflows/deploy.yml/badge.svg)](https://github.com/jinglemansweep/findme/actions/workflows/deploy.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

Operating procedures live in
[docs/RUNBOOK.md](./docs/RUNBOOK.md) (deploy, rollback, incidents),
[docs/TILES.md](./docs/TILES.md) (basemap) and
[docs/MIGRATIONS.md](./docs/MIGRATIONS.md) (schema changes).

## Layout

```
/src        Worker: router, API, HTML shells, LivePin + EmailLimiter DOs,
            PMTiles range proxy, one-shot email, cron sweep
/web        React + Vite + MapLibre SPA, built into /web/dist
/migrations D1 migrations (forward-only)
/test       Vitest via @cloudflare/vitest-plugin (runs against real workerd)
/e2e        Playwright specs driven against a local `wrangler dev`
/scripts    CI helpers (make-ci-wrangler.mjs strips remote bindings)
/docs       Operational docs: RUNBOOK (deploy, rollback, incidents),
            TILES (basemap), MIGRATIONS (schema changes)
```

## Local development

```bash
npm install
npm run build          # build the SPA into web/dist (Worker serves it as assets)
npm run migrate:local  # apply D1 migrations to the local Miniflare database

npm run dev:worker     # Worker on :8787 (D1 + DOs local; tiles read remote R2)
npm run dev:web        # Vite dev server on :5173, proxying /api and /tiles
```

Open http://localhost:5173 (or :8787 for the built app). Without a PMTiles
archive in R2 the map falls back to a public permissive style — see
[docs/TILES.md](./docs/TILES.md) §3 to set up the real basemap.

Two bindings are only useful with `"remote": true` while developing:
`TILES` (set by default) and `EMAIL` (add it when working on email — sends
otherwise no-op locally).

## Tests

```bash
npm test            # builds the SPA first, then runs the workerd-backed suite
npm run test:e2e    # Playwright: boots `wrangler dev` locally, drives Chromium
```

The unit suite covers the pin lifecycle (including extension semantics and the
7-day cap), the kill-switch gating matrix, LivePin read-side expiry enforcement
and alarms, the EmailLimiter window and the recovery-email send path, the cron
sweep (including a multi-batch backlog), label sanitisation and escaping in the
shells, abuse limits (per-IP creation, slug-lookup throttling), the
env-label wrapper, and the PMTiles proxy against a synthetic archive
(including leaf directories and header validation).

The e2e suite runs in a real browser against local workerd (D1 + DOs in
Miniflare): the full create → view → stop lifecycle, control-page reload
recovery, control-link rotation, extensions visible to an open viewer, and
offline/reconnect behaviour. It needs no Cloudflare credentials:
`scripts/make-ci-wrangler.mjs` generates a config with the remote R2 binding
stripped, so the map falls back to the public basemap. CI runs both suites on
every pull request.

## Typecheck

```bash
npm run typecheck
```

## Deploy

One-time setup per environment (see [docs/RUNBOOK.md](./docs/RUNBOOK.md) §2):

```bash
wrangler d1 create findme-staging          # put the id in wrangler.jsonc (env.staging)
wrangler d1 create findme                  # …and env.production
wrangler r2 bucket create findme-tiles     # then follow docs/TILES.md §3
wrangler secret put IP_SALT --env staging
wrangler secret put TURNSTILE_SECRET --env staging   # required before public launch (RUNBOOK §7)
```

Then:

```bash
npm run deploy:staging     # build → migrate → deploy (that order, always)
npm run deploy:production
```

Secrets (`IP_SALT`, `TURNSTILE_SECRET`) are set manually per environment and
deliberately out of band from deploys. CI (`.github/workflows/deploy.yml`)
deploys staging on every push to `main` and production on tags.

## Configuration knobs (wrangler.jsonc `vars`)

| Var | Purpose |
| --- | --- |
| `PMTILES_KEY` / `MAP_BOUNDS` | Which R2 archive to serve and the panning bounds it covers. They move together — going global is a two-value flip (docs/TILES.md §4). |
| `TILES_MAXZOOM` | Max zoom of the archive; drives TileJSON `maxzoom` so MapLibre overzooms instead of blanking. |
| `TURNSTILE_SITE_KEY` | Public site key for the create-form captcha; empty disables the widget. Pair with the `TURNSTILE_SECRET` secret. |
| `KILL_SWITCH` | `"true"` disables pin creation and position writes while leaving existing pins readable. |

## Notes for reviewers

- **`assets_navigation_has_no_effect`** (wrangler.jsonc compat flag) is
  required: since 2025-04-01, navigation requests that miss a static asset
  would otherwise be answered with `index.html` without invoking the Worker,
  which would break the root-level slug URLs (`/:slug`, `/u/:slug`).
- The worker shells boot the SPA through a JSON `<script type="application/json">`
  tag so the CSP can forbid inline scripts; asset filenames in `web/dist`
  are fixed (`/assets/app.js`) for the same reason.
- **maplibre-gl v6 workers**: v6 loads its tile worker from a real
  same-origin module script instead of a blob URL. Since the bundler doesn't
  emit it, `web/scripts/copy-maplibre-vendor.mjs` copies the shipped worker
  files into `web/public/vendor/` at build time and `src/main.tsx` points
  `setWorkerUrl()` at them (CSP: `worker-src 'self' blob:`). The copy runs on
  every `build`/`dev` so the files always match the installed version.
- `GET /api/pins/:slug` (with `X-Pin-Secret`) returns pin metadata for the
  control page: the control page needs the label/expiry to render, and the
  read is already authorised against D1 on that path.

## Licence

GPL-3.0-or-later — see [LICENSE](./LICENSE).
