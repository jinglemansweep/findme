# Find Me — Architecture Plan

Anonymous, no-login, expiring location sharing on Cloudflare.

A user drops a pin (manually or from device GPS), attaches a short message and a
duration, and gets two URLs: a **public** one to share and a **private** one to
update or stop the share. Pins expire and delete themselves. No accounts, no
sign-in, no persistent identity.

---

## 1. Scope

### In scope

- Create a pin from a tapped map location or device GPS.
- Short message/label, bounded TTL.
- Public share URL (exact location) + private control URL (update/extend/stop).
- Manual "Update location" button, plus an optional foreground auto-update toggle.
- Viewers see position updates without refreshing (polling).
- Optional one-shot email of the private URL at creation, for recovery.
- Hand-off links to Google Maps, Apple Maps, OSM, Waze, and `geo:` on Android.
- Mobile-first web app, installable as a PWA later.
- Privacy notice and abuse contact from day one (§11).

### Explicit non-goals

Considered and deliberately dropped. Recorded so they don't get reintroduced by
accident. Reasoning for the auth decision is in §16.

| Dropped | Why |
| --- | --- |
| Public / browsable / searchable pins | Removed the entire moderation burden, the geo-indexing layer, and most of the data-protection surface. Nothing else depended on it. |
| Geographic coarsening / snapping | Only existed to protect the discovery feed. With no discovery, no audience to protect from. |
| Bounding-box or tile-grid search | No spatial queries remain. Every lookup is by primary key. |
| Background location tracking | Not possible in a browser (§10). Promising it would produce confidently stale positions. |
| WebSocket push (v1) | Manual updates are infrequent enough that polling is nearly as immediate, and it removes the riskiest part of the build. Reversible later. |
| Reporting / moderation / admin queue | No public surface to abuse. |
| Accounts / login | Would introduce a permanent identity↔location linkage table, which is the one asset this design deliberately lacks. See §16. |

---

## 2. Architecture

```
Browser ──► Worker ──┬──► D1          slug registry, expiry index
                     ├──► LivePin DO  position + expiry alarm
                     ├──► R2          PMTiles basemap
                     └──► Email       one-shot private-URL send
```

A single Worker serves the SPA assets, the JSON API, and both HTML shells.
Cloudflare recommends Workers with static assets over Pages for new full-stack
projects, and unlike Pages it gives access to Durable Objects and Cron Triggers.

**Why each service is here:**

- **Workers** — routing, API, HTML shells, tile proxy. One deploy.
- **D1** — slug registry and expiry index. Holds *no coordinates, ever*.
- **Durable Objects** — one per pin, holds position and an expiry alarm. Plus a
  rate limiter. SQLite-backed (recommended default; also the only backend on the
  Workers Free plan).
- **R2** — Protomaps PMTiles basemap served via HTTP range requests. No tile API
  key, no vendor rate limits, no third party seeing users' viewports.
- **Email Service** — native `send_email` binding, no third-party API key.
  Requires an onboarded sending domain (§9).

Precise location lives **only** inside the per-pin Durable Object, which wipes
itself on alarm. It never enters D1, its backups, or its exports. That is the
core privacy claim and it should stay true.

---

## 3. URL scheme

```
https://find.narks.uk/aBc123XyZq9k             public — view, exact location
https://find.narks.uk/u/aBc123XyZq9k#s_<key>   private — update, extend, stop
```

Served from a Worker custom domain route on `find.narks.uk/*`. `narks.uk` must
be on Cloudflare DNS.

- **Slug**: 12 chars, Crockford base32 (no `I`/`L`/`O`/`U`), ~60 bits.
- **Secret**: 32 random bytes, base64url, delivered in the **URL fragment**.

The fragment is never sent to the server, so the secret stays out of Cloudflare
logs, analytics, and `Referer` headers. The SPA reads `location.hash`, strips it
via `history.replaceState`, holds it in memory only.

**On `/u/` routes:** `Referrer-Policy: no-referrer`, `Cache-Control: no-store`,
`X-Robots-Tag: noindex`, and **no OG tags at all** — a control URL must never
unfurl a preview in a chat window.

**Anti-footgun:** the two pages must look obviously different, and the control
page carries a large "Copy share link" button that copies the *public* URL, so
the private one is never the convenient thing to paste.

---

## 4. Update model

### Sender (private page)

- Primary control is a **manual "Update location" button** calling
  `getCurrentPosition({ enableHighAccuracy: true })`.
- Optional toggle, labelled honestly: **"Keep updating while this screen is open."**
  Runs `watchPosition`, throttled to fire on >15m movement or >15s elapsed.
  Stops automatically on `visibilitychange → hidden`, and says so visibly.

The user must never believe updating is running when it isn't.

### Viewer (public page)

- Polls `GET /api/pins/:slug/position` every 5s while the tab is visible. This
  path must not touch D1 — see §8.
- Pauses on hidden, stops once expired.
- Renders "updated 40 seconds ago". Compute this from a **server-supplied
  `now`**, not the client clock — device clock skew otherwise produces negative
  or wildly wrong ages.
- Renders the GPS accuracy radius, not a bare dot.

**Three viewer states, never conflated.** The realistic user is walking to a
meetup on patchy mobile data, so "they stopped moving" and "your connection
dropped" must look different:

| State | Trigger | UI |
| --- | --- | --- |
| Live | Poll succeeded, `at` is recent | Position, "updated 20s ago" |
| Stale | Poll succeeded, `at` is old | Position dimmed, "last update 6m ago" |
| Disconnected | 2+ consecutive poll failures | Banner: "Can't reach the server — showing last known position" |

Back off on repeated failure (5s → 10s → 30s, capped) rather than hammering a
dead connection and draining the battery. Resume immediately on
`visibilitychange → visible` or an `online` event.

### Optional cost lever

Wrap the position read in the Cache API with a 3–5s TTL to collapse N viewers
into one DO invocation. Note this places a precise coordinate in a per-colo edge
cache keyed by slug. Short TTL makes it defensible, but **skip it in v1** unless
load demands it.

---

## 5. API

```
POST   /api/pins                    → { slug, secret, publicUrl, privateUrl }
                                      optional body field: email (send once, discard)
GET    /:slug                       public shell (generic OG card, no coords)
GET    /u/:slug#s_…                 control shell (noindex, no-store, no OG)
GET    /api/pins/:slug/position     → { lat, lng, accuracy, at, now }
                                      204 if no fix yet · 410 if expired or stopped
POST   /api/pins/:slug/position     X-Pin-Secret header
PATCH  /api/pins/:slug              extend TTL / edit label
DELETE /api/pins/:slug              stop and wipe
POST   /api/pins/:slug/rotate       mint a new secret
GET    /tiles/*                     PMTiles range proxy → R2
GET    /privacy                     privacy notice
```

**Authorisation lives in D1; serving decisions live in the DO.** Every endpoint
carrying `X-Pin-Secret` reads `secret_hash` from D1 on each call. Writes are rare
(a manual button press, or a throttled auto-update at >15s intervals), so the
round trip costs nothing, and `/rotate` takes effect immediately by construction
rather than by cache invalidation. Only `GET /position` avoids D1 entirely.

There is deliberately **no email resend endpoint** (§9).

TTL options: 15m / 1h / 4h / 24h / 7d. Bounded set, hard maximum, no "forever".

---

## 6. Data model

```sql
CREATE TABLE pins (
  slug        TEXT PRIMARY KEY,        -- 12 chars Crockford base32
  secret_hash TEXT    NOT NULL,        -- sha256(secret), constant-time compare
  label       TEXT,                    -- cap ~140 chars; escape on render
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active'  -- active | stopped
);

CREATE INDEX idx_pins_expiry ON pins(expires_at) WHERE status = 'active';
```

No latitude or longitude column. Deliberately. No email column either.

A stopped pin keeps its row as a tombstone until `expires_at`, so the public URL
returns **410 Gone** rather than 404 — viewers learn the share ended rather than
assuming a broken link. The cron sweep removes it afterwards.

D1 earns its place for two reasons the DO can't cover: slug uniqueness (a
`PRIMARY KEY` insert that fails on collision beats any DO-based scheme) and the
cron sweep (Durable Objects can't be enumerated, so something must be listable).

---

## 7. Durable Object

The DO decides what to **serve**. It does not decide who may write — that is
D1's job (§5).

```js
export class LivePin extends DurableObject {

  // Viewer path. No D1, no auth. Absence of `exp` means gone.
  async getPosition() {
    const exp = await this.ctx.storage.get('exp');
    if (!exp || Date.now() >= exp) return { gone: true };
    const pos = await this.ctx.storage.get('pos');
    return pos ? { ...pos, now: Date.now() } : { pending: true };
  }

  // Called only after the Worker has authorised against D1.
  async setPosition(pos) {
    const exp = await this.ctx.storage.get('exp');
    if (!exp || Date.now() >= exp) return { gone: true };
    await this.ctx.storage.put('pos', { ...pos, at: Date.now() });
    return { ok: true };
  }

  async configure(expiresAtMs) {
    await this.ctx.storage.put('exp', expiresAtMs);
    await this.ctx.storage.setAlarm(expiresAtMs);
    return { ok: true };
  }

  async stop() {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();   // deleteAll() does not clear alarms
    return { ok: true };
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
```

Addressed by `idFromName(slug)`. Pass a `locationHint` derived from the
creator's colo when getting the stub — the sender is the frequent writer.

**`exp` must live in storage, not memory.** The DO is evicted between polls;
anything held only in an instance field is gone on the next request, and the
object would resume serving a position it should have stopped serving.

**Expiry is enforced on read, not only by the alarm.** Alarms fire *at or after*
their scheduled time, so an alarm alone would let a delayed wipe serve a position
past its expiry. The `Date.now() >= exp` check on every read closes that window;
the alarm just reclaims the storage.

**Absence of `exp` means gone**, which gives a free self-healing path: if D1 says
a pin is active but `getPosition()` returns `gone`, the Worker re-issues
`configure()` from the D1 row. That repairs the "D1 row written, DO init failed"
case from §8 lazily, on first view, with no reconciliation job.

Because the DO only handles RPC and `alarm`, none of the WebSocket hibernation
sharp edges apply (constructor re-running after eviction, `getWebSockets()`
returning mid-close sockets). That was the riskiest surface in the original
design.

---

## 8. Lifecycle

**Creation order:** write the D1 row **first**, then initialise the DO.

The row is authoritative for existence. If DO init fails you get a valid pin with
no position yet — `204` from the position endpoint, "waiting for first location"
in the UI. That's a legitimate state anyway, since a pin may be created before
geolocation permission is granted. The reverse order would leave an unreachable DO.

**Division of responsibility.** D1 is authoritative for *existence and
authorisation*: does this slug exist, who may write to it, when should the row be
swept. The DO is authoritative for *serving*: given a viewer poll, is there a
position and may it be returned. Each write path touches both; the viewer poll
path touches only the DO.

That keeps D1 off the poll path — otherwise every poll costs a D1 read and a
round trip for a value that barely changes — while leaving `/rotate` correct
without any cache-invalidation scheme.

**Write ordering follows access, not convenience.** Any change that *reduces*
access is applied to the DO first; any change that *extends* it is applied to D1
first. Both orders then fail closed:

| Operation | Order | If the second step fails |
| --- | --- | --- |
| `DELETE` (stop) | DO `stop()` → D1 `status='stopped'` | DO already serving 410; stale row swept by cron |
| `PATCH` shorten TTL | DO `configure()` → D1 `expires_at` | DO already expiring early; row swept later |
| `PATCH` extend TTL | D1 `expires_at` → DO `configure()` | Pin expires at the old, earlier time |
| `POST /position` | D1 auth read → DO `setPosition()` | No write; sender retries |

The failure the old ordering allowed was the dangerous one: marking D1 stopped
while the DO carried on serving a live position. The stop control is load-bearing
for the coercive-use mitigations in §11, so it has to actually stop things.

**Version the DO storage shape from release one** (`{ v: 1, ... }`). Durable
Object storage has no migration system, and objects created under an old shape
live on for up to 7 days. See `docs/MIGRATIONS.md` §6.

**Alarm handlers must be idempotent.** `alarm()` has guaranteed at-least-once
execution and is retried on uncaught exception with exponential backoff starting
at two seconds, up to six retries. `storage.deleteAll()` is naturally safe to
repeat. Anything added later that has side effects (notifying the sender, say)
is not — use the `alarmInfo` argument (`retryCount`, `isRetry`) to give up rather
than loop. Note also that a DO has only **one** alarm at a time; `setAlarm()`
overwrites, and each call is billed as one row written.

**Cron** (every 10 min):

```sql
DELETE FROM pins WHERE expires_at < ? LIMIT 1000;
```

---

## 9. Email link recovery

The one recovery path for a lost private URL. Optional, off by default, sent
once at creation.

Cloudflare Email Service provides a native `send_email` Workers binding. Note the
onboarding gate: **before** you onboard a sending domain the binding can only
reach verified destination addresses on your account; **after** onboarding, it
can send to any recipient. Onboard the domain during setup or early testing will
fail misleadingly.

Send from a **subdomain** (`mail.narks.uk`), not the apex. A new app sending
transactional mail with bare links is exactly the profile that attracts
reputation damage, and you do not want that landing on `narks.uk` itself.

```jsonc
"send_email": [
  { "name": "EMAIL", "allowed_sender_addresses": ["noreply@mail.narks.uk"] }
]
```

Sender restricted, destination unrestricted. Add `"remote": true` for local dev
to actually send rather than no-op.

```js
await env.EMAIL.send({
  from: 'noreply@mail.narks.uk',
  to: address,
  subject: 'Your location link',
  text: body,
});
```

### Rules

1. **Send only at creation.** No resend endpoint — that is the abuse vector.
2. **Never include the label** or any user-controlled text in the body. It would
   be a free channel to send arbitrary content to arbitrary inboxes over your
   domain's reputation. Body is pure template: URL, expiry time, and the warning
   that anyone holding the link can move the pin.
3. **Rate limit per IP-hash and per recipient address.** Per-recipient limits
   need the `EmailLimiter` DO, not the native binding — see §11. Turnstile also
   gates creation.
4. **Best-effort only.** Never block or fail pin creation on the send — the link
   is already on screen. New accounts start with a conservative daily quota that
   scales with sending reputation, so budget for hitting it.
5. **Discard the address** as soon as `send()` resolves. It is never written to D1.

### Gotchas

- Workers cannot do SMTP at all (V8 isolates have no TCP sockets). The binding or
  a REST API are the only options.
- Emails sent via `send_email` appear as **dropped** in the Email Routing summary
  even when delivered. Use Email Service sending metrics instead.
- Deliverability: domain onboarding configures SPF/DKIM/DMARC, but a bare link to
  an unfamiliar short domain is inherently spam-flavoured. Expect early inbox
  placement issues.

---

## 10. Known limitations

**Browser geolocation cannot run in the background.** When the phone locks or the
tab is backgrounded, `watchPosition` stops. There is no service-worker escape
hatch on iOS. Not fixable; the UI must be honest — hence the manual-first model.

**Indoor accuracy is poor** (50m+ is common), permission can be denied outright,
and iOS Safari has quirks around `enableHighAccuracy`. Always show the accuracy
radius, and always offer manual map-tap as a fallback when permission is refused.

**R2 range-request latency** can spike to 500ms–1s, visible on first map paint.
Mitigate with long `Cache-Control` on the tile route.

**OG previews leak permanently.** A preview image is fetched and cached by the
messaging platform's CDN — outside your control and outliving the TTL. Therefore
**no map in the OG image**: use a generic branded card, no coordinates in meta
tags.

---

## 11. Security & privacy

- **Slug entropy carries the entire security model.** With no discovery feed, the
  slug is the only barrier between an attacker and a live position. 60 bits plus
  aggressive per-IP-hash rate limiting on 404s. Nothing sits behind it — worth a
  deliberate review before launch.
- **Secret handling.** Fragment + in-memory (optionally `localStorage`) on one
  device. Mitigations: distinct pages, prominent copy-public-link button, rotate
  endpoint, and the optional email (§9).
- **Escape the label** wherever it is rendered. It is user-controlled text on a
  server-rendered HTML shell.
- **Rate limiting** by IP hashed with a daily-rotating salt held in a Worker
  Secret. Abuse control without retaining anything identifying.
  - Use the **native `ratelimits` binding** for slug-lookup 404s and pin
    creation. Counting is approximate and local to the Cloudflare location
    serving the request, which is fine for raising the cost of enumeration.
  - Use the **`EmailLimiter` DO**, keyed on `sha256(recipient)`, for
    per-recipient email quotas. Per-colo approximation fails exactly where it
    matters most: an attacker routing through several regions to repeatedly mail
    one victim. This is the one case that needs exact global counting.
  - `EmailLimiter` **must delete itself.** One object per recipient hash,
    created and never reclaimed, accumulates storage cost indefinitely for a
    counter that is meaningless after its window closes — Durable Objects are
    billed for stored data until that data is removed. Set an alarm to the end
    of the window; the handler calls `deleteAll()`. Like `LivePin.alarm()` it is
    naturally idempotent, which matters because alarms retry (§8).
- **Turnstile** on pin creation.
- **Coercive use.** Anonymous live location sharing with a control URL is a
  plausible stalking tool. Mitigations: hard TTL caps, a prominent always-visible
  stop control, no silent restart after expiry. The manual-update default helps —
  repeated conscious taps make a poor covert tracker.
- **UK GDPR.** Location is personal data even without a login. The notice lives
  in `PRIVACY.md`, is served at `/privacy`, and is linked from the footer of both
  shells. It is a **launch blocker, not polish** — write it in phase 1 while the
  design decisions are fresh rather than reconstructing them later. The
  architecture has already made it a short document.
- **Abuse contact.** `abuse@narks.uk`, linked in the footer and named in the
  privacy notice. The §11 coercive-use mitigations are otherwise entirely
  technical: if someone is being tracked through this service there must be a way
  to reach a human. Handling procedure is in `docs/RUNBOOK.md` §5 — note that
  stopping a pin requires wiping the DO as well as updating D1.
- **Email wording must be accurate.** The address is not stored by this app, but
  Cloudflare's Email Service dashboard retains delivery results, bounces and
  suppressions. Say "we send once and don't keep it; our email provider retains
  delivery logs" — not "we don't store your email address".
- **ODbL attribution** is required for Protomaps/OSM basemaps and must be rendered.

---

## 12. Map hand-off links

| Target | URL |
| --- | --- |
| Google Maps | `https://www.google.com/maps/search/?api=1&query=LAT,LNG` |
| Apple Maps | `https://maps.apple.com/?ll=LAT,LNG&q=LABEL` |
| Android native | `geo:LAT,LNG?q=LAT,LNG(LABEL)` |
| OpenStreetMap | `https://www.openstreetmap.org/?mlat=LAT&mlon=LNG#map=17/LAT/LNG` |
| Waze | `https://waze.com/ul?ll=LAT,LNG&navigate=yes` |

Detect platform and surface the two or three that make sense, not all five.

---

## 13. Wrangler

```jsonc
{
  "name": "findme",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "assets": {
    "directory": "./web/dist",
    "not_found_handling": "single-page-application"
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "findme", "database_id": "..." }
  ],
  "r2_buckets": [
    { "binding": "TILES", "bucket_name": "findme-tiles", "remote": true }
  ],
  "vars": {
    "PMTILES_KEY": "uk.pmtiles",
    "TILES_MAXZOOM": "14",
    "MAP_BOUNDS": "-8.65,49.84,1.77,60.86",
    "ABUSE_EMAIL": "abuse@narks.uk"
  },
  "durable_objects": {
    "bindings": [
      { "name": "LIVE_PIN", "class_name": "LivePin" },
      { "name": "EMAIL_LIMITER", "class_name": "EmailLimiter" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["LivePin", "EmailLimiter"] }
  ],
  "ratelimits": [
    { "name": "SLUG_LOOKUPS", "namespace_id": "1001",
      "simple": { "limit": 60, "period": 60 } },
    { "name": "PIN_CREATES", "namespace_id": "1002",
      "simple": { "limit": 10, "period": 60 } }
  ],
  "send_email": [
    { "name": "EMAIL", "allowed_sender_addresses": ["noreply@mail.narks.uk"] }
  ],
  "limits": { "cpu_ms": 200 },
  "triggers": { "crons": ["*/10 * * * *"] }
}
```

`ratelimits` requires Wrangler 4.36.0 or later. `limits.cpu_ms` is a
denial-of-wallet guard — see §17.

`PMTILES_KEY` and `MAP_BOUNDS` are deliberately variables, and they move
together: going global is a two-value flip and a redeploy, with a one-line
rollback. `MAP_BOUNDS` feeds MapLibre's `maxBounds` so panning is constrained to
the area the archive actually covers — set it to the world extent when
`PMTILES_KEY` becomes the planet archive. See `docs/TILES.md`.

`"remote": true` on the R2 binding makes `wrangler dev` read the real bucket. A
multi-gigabyte archive does not belong on a laptop, and a smaller local extract
drifts out of sync and has you debugging a difference that does not exist in
production. Set it on the `EMAIL` binding too when working on §9, or sends are
silently no-ops.

`new_sqlite_classes`, **not** `new_classes` — that is what selects the SQLite
storage backend.

Use named environments (`env.staging`, `env.production`) with separate D1
databases.

### Commands

```bash
wrangler d1 migrations create findme <name>
wrangler d1 migrations apply findme --local     # then --remote
wrangler secret put IP_SALT
wrangler secret put TURNSTILE_SECRET
wrangler dev                                     # D1 + DOs run in Miniflare
wrangler deploy --env production
```

CI via `cloudflare/wrangler-action`.

---

## 14. Repo layout

```
/src
  index.ts              router
  api/pins.ts           create / read / update / delete / rotate
  do/LivePin.ts
  do/EmailLimiter.ts   per-recipient email quota (see §11)
  shells/public.ts      HTML for /:slug
  shells/control.ts     HTML for /u/:slug
  tiles/pmtiles.ts      R2 range-request proxy
  email/send.ts         one-shot private-URL email
  shells/privacy.ts     serves PRIVACY.md at /privacy
  lib/slug.ts           Crockford base32 generation
  lib/auth.ts           secret hashing, constant-time compare
  cron.ts               expiry sweep
/migrations
  0001_init.sql
/docs
  TILES.md              PMTiles + R2 runbook: setup, refresh, UK → planet
  RUNBOOK.md            deploy, rollback, incident response, cost controls
  MIGRATIONS.md         D1 schema changes and DO storage shape changes
/web                    React + Vite + MapLibre GL SPA → /web/dist
PRIVACY.md              user-facing privacy notice, served at /privacy
wrangler.jsonc
```

**Frontend:** React + Vite. Use `maplibre-gl` directly rather than a React
wrapper — there is exactly one map instance, its lifecycle is imperative, and a
wrapper adds a dependency and an abstraction for no benefit at this size. Hold
the map in a ref, drive it from effects.

Documentation is a deliverable, not an afterthought. `docs/TILES.md` exists
because the tile pipeline is the one part of this system that is operated rather
than deployed — it involves a multi-gigabyte artefact, a CLI nobody uses daily,
and an upgrade path that must still work months later. Written down once, it
takes twenty minutes to follow. Not written down, it is an afternoon of
rediscovery every time.

---

## 15. Phasing

1. **Core.** Create pin, both URLs, manual update button, viewer polling with the
   three connection states, TTL, DO alarm, cron sweep, map hand-off links,
   privacy notice and abuse contact. Any permissive tile source for dev.
2. **Auto-update toggle.** Foreground `watchPosition`, movement throttling,
   unambiguous on/off state.
3. **Basemap.** UK extract (z0–14) in R2 behind the range-request Worker,
   MapLibre style, glyphs and sprites in R2, ODbL attribution. Write
   `docs/TILES.md` as this is built, not afterwards. Planet upgrade stays a
   config flip.
4. **Recovery & polish.** Email link send (onboard `mail.narks.uk` first),
   secret rotation, TTL extension, PWA manifest, budget alerts (§17),
   edge-cache the position read if load warrants.

WebSocket push remains available as a later addition. Because viewers already
read from the DO by slug, adding it changes neither the data model nor the URL
scheme.

---

## 16. Deferred decisions

### Accounts / authentication

Better Auth runs fine on Workers + D1 (`better-auth-cloudflare` covers the
adapter, KV session caching, and migrations). Deferred anyway, because the only
problem it solved for v1 was private-URL recovery, and email solves that at a
fraction of the cost.

What accounts would cost: permanent `user`/`session`/`account` tables that break
the "everything expires within 7 days" retention story, the full GDPR apparatus
(DSARs, erasure, portability, breach notification), and — if `pins.user_id`
exists — a durable linkage between an identity and a stream of locations. That
linkage is the asset a breach or court order targets, and its absence is the
point of this design.

The Anonymous plugin does not avoid this: it creates a real user row and the
whole purpose of `onLinkAccount` is that the anonymous activity survives the
upgrade.

**If accounts are added later**, prefer loose coupling: the account stores an
encrypted keyring of pin secrets, encrypted client-side with a key derived from
the user's password. The server holds an opaque blob and never learns which pins
belong to whom; `pins` keeps no `user_id`. Cost: a password reset loses the
keyring, which is honest and can be stated up front.

**Config warning:** `better-auth-cloudflare` ships `autoDetectIpAddress` and
`geolocationTracking`, which enrich sessions with request-derived location. For
this app those are exactly wrong. Disable explicitly, with a comment saying why.

Also budget debugging time: there are known reports of D1 503s and long hangs
surfacing at the Worker boundary, where the auth handler logs 200 but the client
sees a failure.

---

## 17. Cost controls and billing safety

**Cloudflare has no hard spend cap.** Budget alerts are informational only — they
do not pause or cap usage. There is no switch that stops the bill at £20. Plan
accordingly.

What does exist:

- **Budget alerts** (Billing → Budget alerts) email you when projected spend
  crosses a threshold. Calculated daily, fire once per billing cycle.
- **Billable Usage dashboard** shows daily cost per metered product.
- **Usage notifications** (Notifications tab) alert on specific metrics —
  Workers requests, R2 operations — rather than total spend.
- **`limits.cpu_ms`** in Wrangler is the one genuine hard control: it caps CPU
  time per invocation and is the documented defence against denial-of-wallet.

Set all of these before the first public link is shared.

### Application-level guards

Because the platform will not stop for you, the kill switches have to be yours:

- `limits.cpu_ms` set conservatively (200ms is generous for this workload).
- Native rate limits on pin creation and slug lookups (§11).
- Hard TTL ceiling, so no pin can hold a DO resident indefinitely.
- Long `Cache-Control` on `/tiles/*` — cached responses cost no R2 operations.
- A `KILL_SWITCH` var checked on write paths, so creation can be disabled with a
  redeploy while leaving existing pins readable.

### Expected shape

At ~1,000 pins/month the whole system sits inside included allowances: **$5/mo**,
the Workers Paid minimum. Duration is the cost driver and scales with
*concurrently viewed pins × session length*, not viewer count — a DO stays
resident while polls arrive, and ten viewers on one pin cost the same as one.

Watch the rounding: billable usage rounds up to the next unit, so 368k GB-s of
overage bills as a full million at $12.50. Small overages are disproportionately
expensive.

---

## 18. Open items

- **Accessibility** — the interface is a map canvas, which is close to unusable
  with a screen reader. A text block with coordinates, the label, the freshness
  state and the map hand-off links would cover most of it cheaply. WebGL
  fallback is explicitly *not* being pursued.
- **Observability** — undecided. Options: nothing for v1, Workers Logs only, or
  an Analytics Engine binding for creation and view counts.
- **Testing DO alarms** — Miniflare doesn't faithfully reproduce eviction. Write
  Vitest coverage against the Workers pool early.
- **Photos in R2** — deferred, not designed. Would reintroduce a moderation
  question, so think before adding.
