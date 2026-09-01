-- Pin registry: existence, authorisation and expiry only.
-- No latitude, no longitude, no email — ever (PLAN.md §6).
CREATE TABLE pins (
  slug        TEXT PRIMARY KEY,        -- 12 chars Crockford base32
  secret_hash TEXT    NOT NULL,        -- sha256(secret), constant-time compare
  label       TEXT,                    -- cap ~140 chars; escape on render
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'active'  -- active | stopped
);

CREATE INDEX idx_pins_expiry ON pins(expires_at) WHERE status = 'active';
