# Runbook

Operating Find Me: deploying, rolling back, responding when something breaks, and
keeping the bill predictable.

Companion to `docs/TILES.md`, which covers the basemap specifically.

---

## 1. Environments

| Environment | Worker | D1 | Domain |
| --- | --- | --- | --- |
| local | `wrangler dev` | local Miniflare D1 | `localhost:8787` |
| staging | `findme-staging` | `findme-staging` | `findme-staging.<subdomain>.workers.dev` (custom domain `staging.find.narks.uk` once `narks.uk` is on the account) |
| production | `findme` | `findme` | `findme.<subdomain>.workers.dev` (custom domain `find.narks.uk` later) |

Until the custom domains are attached, both environments serve from their
`workers.dev` URLs — see yours under Workers → your Worker → Settings → Domains
& Routes. Switching over is uncommenting the `routes` block in
`wrangler.jsonc` and redeploying; the Worker stays reachable on both origins,
though share links are only as durable as the origin they were minted with.

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

The two-release pattern for removing a column:

1. Release A: stop reading and writing it. Deploy. Confirm.
2. Release B: drop it in a migration.

### CI

`cloudflare/wrangler-action` with an API token scoped to Workers Scripts edit, D1
edit, and R2 edit. Store as a repository secret; never commit it.

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
`configure()` from the D1 row on first view (`PLAN.md` §7). If it is not, that
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
whether the daily quota has been hit — new accounts start conservative.

### Abuse report received

Reports arrive at `abuse@narks.uk`, usually with a pin link.

1. Take the slug from the link.
2. `UPDATE pins SET status='stopped' WHERE slug=?` **and** call `stop()` on the
   DO — in that order per `PLAN.md` §8. Stopping only the D1 row leaves the
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
volume, with Durable Object duration as the line that grows first. See `PLAN.md`
§17.

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
