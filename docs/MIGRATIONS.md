# Migrations

Changing the shape of stored data: D1 schema, and the Durable Object storage that
nobody calls a database but is one.

Companion to `docs/RUNBOOK.md` (deploys, rollback) and `PLAN.md` §6–8 (the data
model and why it is split the way it is).

---

## 1. What the tooling gives you

`wrangler d1 migrations` is **forward-only**. Numbered files in `/migrations`,
applied in order, with the applied set tracked in a `d1_migrations` table inside
the database itself.

There is no `down` migration and no revert command. If a migration is wrong, the
options are a new migration that corrects it, or a Time Travel restore (§3).

Two rules follow:

- **Never edit an applied migration.** Not locally, not after it has run on
  staging. Write a new one. The applied-set tracking is by filename.
- **One concern per file.** A file that fails partway leaves partial state, and
  small files make that trivial to reason about instead of forensic.

### Naming collision warning

`wrangler.jsonc` contains a `"migrations"` key:

```jsonc
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["LivePin", "EmailLimiter"] }]
```

That is **Durable Object class lifecycle** and has nothing to do with SQL. It
tracks which DO classes exist and which storage backend they use. Unrelated
system, unfortunate shared name. Renaming or removing a DO class after a deploy
needs an entry here with `deleted_classes` or `renamed_classes`.

---

## 2. The advantage this project has

**Nothing in `pins` lives longer than 7 days.**

That collapses the hardest part of most migrations — backfilling existing rows —
into *waiting*.

Adding a `NOT NULL` column elsewhere means: add nullable, backfill in batches,
verify, tighten. Here it means: add nullable, let new rows populate it, and
within a week every row that lacked it has expired on its own. No backfill
script, no batching, no long-running job, no partial-state window to reason
about.

The same trick works for table rebuilds (§5) and for DO storage shapes (§6).
Whenever a migration looks painful, ask whether waiting a week solves it. It
usually does.

**The blunt option is also available.** If a migration goes badly wrong you can
drop and recreate `pins`. That breaks every live share and should never be a
first resort — but the blast radius is "people re-send a link", not "customer
data destroyed". Knowing the floor is that high should make you *less* cautious
about routine changes, not more.

---

## 3. Time Travel

D1 provides point-in-time recovery to any minute within the last **30 days** on
Workers Paid (7 days on Free), at no additional cost.

```bash
# Find the bookmark for a point in time
wrangler d1 time-travel info findme --timestamp=2026-09-01T14:00:00Z

# Restore (destructive, in place, whole database)
wrangler d1 time-travel restore findme --bookmark=<bookmark>
```

It restores the **entire database**, not just the schema — so it undoes the bad
migration and every write since. For most services that is a blunt instrument.
Here, restoring to twenty minutes ago loses twenty minutes of pins. Annoying, not
serious.

**Take a bookmark before any production migration that is not a plain
`ADD COLUMN`.** It costs nothing and converts a bad afternoon into five minutes.

---

## 4. Expand and contract

`wrangler rollback` reverts **code only** — not migrations, not R2, not DO
storage. So if code and schema move together, a rollback lands old code on a new
schema.

The discipline: **every intermediate state must work with both the old and new
code.**

### Removing a column

| Release | Change | Rollback safe? |
| --- | --- | --- |
| A | Code stops reading and writing the column. Schema unchanged. | Yes |
| — | *Wait. Confirm nothing broke.* | |
| B | Migration drops the column. | Yes — code already ignores it |

### Adding a column

| Release | Change | Rollback safe? |
| --- | --- | --- |
| A | Migration adds it with a default. Code ignores it. | Yes |
| B | Code reads and writes it. | Yes — column already exists |

Never combine A and B into one release. The temptation is strong for small
changes and it is exactly where the rollback trap closes.

---

## 5. SQLite's ALTER TABLE limits

D1 is SQLite, so `ALTER TABLE` is narrow.

| Supported | Not supported |
| --- | --- |
| `ADD COLUMN` (constant default only) | Changing a column type |
| `DROP COLUMN` | Adding a constraint or `CHECK` |
| `RENAME COLUMN` | Adding `NOT NULL` to a populated table |
| `RENAME TO` | Altering a default |

Anything in the right column needs a **table rebuild**:

```sql
CREATE TABLE pins_new (
  slug        TEXT PRIMARY KEY,
  secret_hash TEXT    NOT NULL,
  label       TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active'
);

INSERT INTO pins_new SELECT slug, secret_hash, label, created_at, expires_at, status
FROM pins;

DROP TABLE pins;
ALTER TABLE pins_new RENAME TO pins;

-- MUST be recreated: indexes are dropped with the table
CREATE INDEX idx_pins_expiry ON pins(expires_at) WHERE status = 'active';
```

**Indexes are dropped along with the table.** Forgetting to recreate them is the
classic failure here, and it is *silent* — everything still works, just slowly
and expensively, because D1 bills on rows scanned rather than rows returned.

Always verify after a rebuild:

```bash
wrangler d1 execute findme --remote --command "PRAGMA table_info(pins)"
wrangler d1 execute findme --remote --command \
  "SELECT name, sql FROM sqlite_master WHERE type='index'"
```

### The cheaper alternative

Given §2, you often do not need the rebuild at all. Create the new table empty,
have the code write to the new one and read from both, and drop the old one a
week later once it has drained. No `INSERT INTO ... SELECT`, no lock, no index
mistake.

---

## 6. Durable Object storage

`LivePin` stores `pos` and `exp`. `EmailLimiter` stores a counter. **Neither has
a migration system.** There is no tooling, no version table, and no way to
enumerate objects to update them.

Worse, live objects created under the old shape persist for up to 7 days and wake
up on the next poll — so a shape change is not a deploy-time event, it is a
week-long overlap.

**Version the stored shape from the first release.** It costs nothing now and is
the only thing that gives you somewhere to branch later:

```js
await this.ctx.storage.put('pos', { v: 1, lat, lng, accuracy, at: Date.now() });
```

Then a shape change is a tolerant read:

```js
const pos = await this.ctx.storage.get('pos');
if (!pos) return { pending: true };
if (pos.v === 1) return upgrade(pos);   // or: return { gone: true }
```

Same expand/contract as §4, and the same escape hatch as §2: ship the reader that
tolerates both shapes, wait a week for old objects to expire, then delete the old
branch in a later release.

Where tolerating both shapes is genuinely hard, treating an old-shape object as
`gone` is a legitimate choice. It ends some live shares early, which is poor but
recoverable — the user re-shares. Decide deliberately rather than by omission.

---

## 7. Workflow

```bash
# 1. Create
wrangler d1 migrations create findme add_view_count

# 2. Local
wrangler d1 migrations apply findme --local
wrangler dev                                   # smoke test

# 3. Staging
wrangler d1 migrations apply findme --env staging --remote
wrangler deploy --env staging
# verify schema and indexes; run through create → view → update → stop

# 4. Production
wrangler d1 time-travel info findme --timestamp=$(date -u +%FT%TZ)   # note bookmark
wrangler d1 migrations apply findme --env production --remote
wrangler deploy --env production
```

Migrations **before** deploy, always, and the CI job must fail if the migration
step fails. See `docs/RUNBOOK.md` §2.

---

## 8. Checklist

Before applying anything to production:

- [ ] Migration file is new, not an edit to an applied one
- [ ] Single concern per file
- [ ] Additive, or the second half of an expand/contract pair
- [ ] Old code still works against the new schema
- [ ] Indexes recreated if a table was rebuilt
- [ ] Applied and verified on staging
- [ ] Time Travel bookmark recorded (anything beyond `ADD COLUMN`)
- [ ] If DO storage shape changed: readers tolerate both, or old shape is
      deliberately treated as gone
