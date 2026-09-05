# Runbook

Operating Find Me: deploying, rolling back, responding when something breaks, and
keeping the bill predictable.

Companion to `docs/TILES.md`, which covers the basemap specifically.

---

## 1. Environments

| Environment | Worker | D1 | Domain |
| --- | --- | --- | --- |
| local | `wrangler dev` | local Miniflare D1 | `localhost:8787` |
| staging | `findme-staging` | `findme-staging` | `find-stg.appts.uk` (custom domain; `findme-staging.<subdomain>.workers.dev` also works) |
| production | `findme` | `findme` | `find.appts.uk` (custom domain; `findme.<subdomain>.workers.dev` also works) |

Both environments serve from their custom domains (the `routes` blocks in
`wrangler.jsonc`) and stay reachable on their `workers.dev` URLs — see yours
under Workers → your Worker → Settings → Domains & Routes. Share links are
only as durable as the origin they were minted with.

Separate D1 databases per environment. Never point staging at production data —
the whole point of the retention story is that production data is short-lived and
unremarkable, and copying it defeats that.

---

## 2. Deploying

**Order matters.** Migrations must apply before the code that depends on them.

```bash
wrangler d1 migrations apply findme --env production --remote
wrangler deploy --env production
```

If the deploy fails after migrations have applied, you are running old code
against a new schema. Keep migrations **additive** — add columns, add tables,
never drop or rename in the same release as the code that stops using them. Then
old code continues to work and a rollback is safe.

**Named environments restate their own bindings.** Wrangler environments do
*not* inherit `vars`, `durable_objects`, `r2_buckets`, `ratelimits`, or
`send_email` — only `d1_databases` differs between `env.staging` and
`env.production`, but each env block carries the full set. A deploy with a
missing binding succeeds silently (code catches the error and the feature
just breaks at runtime), so CI dry-runs each environment and asserts the
`LIVE_PIN` Durable Object binding is present.

The two-release pattern for removing a column:

1. Release A: stop reading and writing it. Deploy. Confirm.
2. Release B: drop it in a migration.

### CI

`.github/workflows/deploy.yml` runs `npx wrangler` directly, authenticated with
a repository secret (`CLOUDFLARE_API_TOKEN`) holding an API token scoped to
Workers Scripts edit, D1 edit, and R2 edit. Store as a repository secret; never
commit it.

Pull requests run the typecheck, the workerd-backed unit suite, the binding
dry-runs and the Playwright e2e suite — all without Cloudflare secrets, so
fork PRs are fully tested too. The e2e job generates `wrangler.ci.jsonc`
(`scripts/make-ci-wrangler.mjs`) with the remote R2 binding stripped, because
remote bindings make `wrangler dev` demand an API token; without the bucket the
app falls back to the public basemap.

```yaml
- run: npx wrangler d1 migrations apply findme --env production --remote
- run: npx wrangler deploy --env production
```

Two things `wrangler-action` will not do for you:

- **Ordering.** Migrations and deploy are separate steps; keep them in that order
  and fail the job if the first fails.
- **Secrets.** `wrangler secret put` is manual and out of band. Rotating
  `IP_SALT` or `TURNSTILE_SECRET` is a deliberate act, not a deploy artefact.

Run staging on every push to `main`; gate production behind a tag or manual
approval.

---

## 3. Rolling back

```bash
wrangler deployments list
wrangler rollback [<version-id>] --env production
```

Rollback reverts **code only**. It does not revert D1 migrations, R2 objects, or
Durable Object storage. This is why migrations must be additive.

For the basemap, rollback is a `PMTILES_KEY` flip — see `docs/TILES.md` §4.

---

## 4. Local development

```bash
wrangler dev
```

D1 and Durable Objects run locally in Miniflare with no setup.

Two bindings need `"remote": true` to be useful locally:

- **`TILES` (R2).** The basemap archive is multi-gigabyte; you do not want a copy
  on your laptop, and a smaller local extract drifts out of sync with production
  and has you debugging differences that do not exist. Read the real bucket.
- **`EMAIL`.** Otherwise sends are no-ops and you will not discover a
  misconfiguration until production.

Remote bindings hit real resources and incur real usage. R2 reads are cheap;
email sends count against your quota. Be deliberate with the email one.

---

## 5. Incident response

### Symptom: pins create but never show a position

Check whether `configure()` is reaching the DO. If D1 says active and
`getPosition()` returns `gone`, the Worker's self-healing path should re-issue
`configure()` from the D1 row on first view. If it is not, that
path is broken.

### Symptom: map blank or unlabelled

`docs/TILES.md` §8. Almost always `PMTILES_KEY` mismatch or missing glyphs.

### Symptom: sudden traffic spike

1. Check Workers Logs for the pattern — enumeration attempts show as a flood of
   404s on `/:slug`.
2. Tighten `ratelimits` in `wrangler.jsonc` and redeploy.
3. If needed, set `KILL_SWITCH` to disable pin creation while leaving existing
   pins readable, and deploy.

### Symptom: emails not arriving

Note that sends via `send_email` appear as **dropped** in the Email Routing
summary even when delivered. Use Email Service sending metrics instead. Check
whether the daily quota has been hit — new accounts start conservative. If
sends fail outright, see §8 — the domain may not be onboarded.

### Abuse report received

Reports arrive at `abuse@appts.uk`, usually with a pin link.

1. Take the slug from the link.
2. `UPDATE pins SET status='stopped' WHERE slug=?` **and** call `stop()` on the
   DO — in that order. Stopping only the D1 row leaves the
   position being served.
3. Record the slug and the action. Do not record the reporter's details beyond
   what is needed to reply.

Treat reports of someone being tracked as urgent. The pin will expire on its own,
but "wait up to seven days" is not an answer to give someone who is frightened.

---

## 6. Cost and monitoring

Configure before the first public link is shared:

- **Budget alerts** (Billing → Budget alerts) at a threshold you would actually
  react to. They are informational only and will not cap spend.
- **Usage notifications** for Workers requests and R2 operations.
- **`limits.cpu_ms`** in `wrangler.jsonc` — the one genuine hard control.

Review monthly under Billing → Billable Usage. Expect roughly $5/month at low
volume, with Durable Object duration as the line that grows first.

---

## 7. Secrets

| Secret | Purpose | Rotation |
| --- | --- | --- |
| `IP_SALT` | Daily-rotating salt for IP hashing | Rotates itself; the seed rarely changes |
| `TURNSTILE_SECRET` | Bot protection on pin creation | On compromise |
| CI API token | Deploys | Annually, or on staff change |

```bash
wrangler secret put IP_SALT --env production
```

Rotating `IP_SALT` invalidates in-flight rate limit counters. Harmless, but
expect a brief window where limits reset.

### Enabling Turnstile (required before public launch)

Without the captcha, pin creation is gated only by the per-IP rate limit
(approximate, per-colo), which makes the recovery-email sender a spam surface
over this domain's reputation. Enable it per environment:

1. Dashboard → Turnstile → **Add site**. Domains: the environment's host
   (`find.appts.uk`, plus `find-stg.appts.uk` for staging). Take the *site key*.
2. Put the site key in `wrangler.jsonc` → `vars.TURNSTILE_SITE_KEY` for that
   environment, and deploy. (Empty string = widget disabled; that is the
   current state in this file until you do this.)
3. Store the *secret key* out of band:
   `wrangler secret put TURNSTILE_SECRET --env production` (and `--env staging`).
4. Verify on staging: the create form shows the challenge, and a create with it
   succeeds. With `TURNSTILE_SECRET` set but the widget absent, every create
   fails with `captcha verification failed` — the two settings move together.

---

## 8. Email sending setup

One-time Cloudflare setup for the recovery email. Until the sending domain is
onboarded, every send fails with `E_SENDER_DOMAIN_NOT_AVAILABLE` (or, on
unonboarded accounts, only reaches verified destination addresses).

1. Dashboard → Email Service → Email Sending → **Onboard Domain**, choose
   `appts.uk`, review the records, Done.
2. Cloudflare adds them itself: MX ×3 and SPF on `cf-bounce.appts.uk`, DKIM on
   `cf-bounce._domainkey.appts.uk`, DMARC at `_dmarc.appts.uk` (start with
   `none` — monitor mode). Propagation usually takes 5–15 minutes.
3. Verify from staging: create a pin with an address you own; the create
   response should report `"email": "sent"` and the mail should arrive.

Failure signatures in the create response: `"failed"` means the send threw —
check Workers Logs for the error code (`E_SENDER_DOMAIN_NOT_AVAILABLE` = domain
not onboarded; `E_SENDER_NOT_VERIFIED` = the subdomain sender is not accepted,
in which case switch to `noreply@appts.uk`). `"skipped"` means there is no
`EMAIL` binding — a named env is missing its `send_email` block. The sender
lives in two places that must agree: `SENDER` in `src/email/send.ts` and
`allowed_sender_addresses` in all three `wrangler.jsonc` env blocks.
