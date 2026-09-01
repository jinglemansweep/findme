import type { Env } from "../env";
import type { LivePin } from "../do/LivePin";
import { generateSecret, hashSecret, timingSafeEqual } from "../lib/auth";
import { errorJson, json, killSwitchOn } from "../lib/http";
import { ipHash, rateLimitOk } from "../lib/ratelimit";
import { generateSlug, isSlug, SLUG_LENGTH } from "../lib/slug";
import { verifyTurnstile } from "../lib/turnstile";
import { sendRecoveryEmail } from "../email/send";

/** Bounded TTL set, hard maximum, no "forever" (PLAN.md §5). */
export const TTL_OPTIONS_SECONDS = [900, 3600, 14400, 86400, 604800] as const;
const MAX_TTL_MS = 604_800_000;
const LABEL_MAX_CHARS = 140;
const MAX_BODY_CHARS = 4096;

const CONTINENT_TO_HINT: Record<string, DurableObjectLocationHint> = {
  NA: "enam",
  SA: "sam",
  AF: "afr",
  AS: "apac",
  OC: "oc",
  EU: "weur",
};

export interface PinRow {
  slug: string;
  secret_hash: string;
  label: string | null;
  created_at: number;
  expires_at: number;
  status: string;
}

export function getPinStub(env: Env, slug: string, request?: Request): DurableObjectStub<LivePin> {
  const id = env.LIVE_PIN.idFromName(slug);
  // The sender is the frequent writer — hint the object towards the creator.
  // The viewer poll path passes no request; placement is best-effort anyway.
  const hint = CONTINENT_TO_HINT[(request?.cf as { continent?: string } | undefined)?.continent ?? ""];
  return env.LIVE_PIN.get(id, hint ? { locationHint: hint } : undefined);
}

export async function findPin(env: Env, slug: string): Promise<PinRow | null> {
  return env.DB.prepare(
    "SELECT slug, secret_hash, label, created_at, expires_at, status FROM pins WHERE slug = ?",
  )
    .bind(slug)
    .first<PinRow>();
}

async function authorize(
  env: Env,
  slug: string,
  secret: string | null,
): Promise<{ row: PinRow } | { response: Response }> {
  if (!isSlug(slug)) return { response: errorJson(404, "not found") };
  if (!secret) return { response: errorJson(401, "missing secret") };
  const row = await findPin(env, slug);
  if (!row) return { response: errorJson(404, "not found") };
  const candidate = await hashSecret(secret);
  if (!timingSafeEqual(candidate, row.secret_hash)) {
    return { response: errorJson(401, "invalid secret") };
  }
  return { row };
}

function sanitizeLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const cleaned = label
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, LABEL_MAX_CHARS).join("");
}

function parsePosition(body: Record<string, unknown>): { lat: number; lng: number; accuracy: number | null } | { error: string } {
  const { lat, lng, accuracy } = body;
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { error: "lat and lng must be numbers" };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { error: "lat/lng out of range" };
  }
  if (accuracy !== undefined && accuracy !== null) {
    if (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100_000) {
      return { error: "accuracy must be a number in metres (0–100000)" };
    }
  }
  return { lat, lng, accuracy: typeof accuracy === "number" ? accuracy : null };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return errorJson(413, "body too large");
  try {
    const parsed = JSON.parse(text || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return errorJson(400, "body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    return errorJson(400, "invalid JSON body");
  }
}

export function publicUrl(origin: string, slug: string): string {
  return `${origin}/${slug}`;
}

export function privateUrl(origin: string, slug: string, secret: string): string {
  // The secret travels in the fragment, which browsers never send to servers.
  return `${origin}/u/${slug}#s_${secret}`;
}

export async function createPin(request: Request, env: Env, url: URL): Promise<Response> {
  if (killSwitchOn(env)) return errorJson(503, "pin creation is temporarily disabled");

  const limiterKey = `create:${await ipHash(env, request)}`;
  if (!(await rateLimitOk(env.PIN_CREATES, limiterKey))) return errorJson(429, "too many pins created recently");

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  if (!(await verifyTurnstile(env, request, typeof body.turnstileToken === "string" ? body.turnstileToken : undefined))) {
    return errorJson(403, "captcha verification failed");
  }

  const ttlSeconds = body.ttl;
  if (typeof ttlSeconds !== "number" || !TTL_OPTIONS_SECONDS.includes(ttlSeconds as (typeof TTL_OPTIONS_SECONDS)[number])) {
    return errorJson(400, `ttl must be one of ${TTL_OPTIONS_SECONDS.join(", ")}`);
  }

  let position: { lat: number; lng: number; accuracy: number | null } | null = null;
  if (body.lat !== undefined || body.lng !== undefined) {
    const parsed = parsePosition(body);
    if ("error" in parsed) return errorJson(400, parsed.error);
    position = parsed;
  }

  const label = sanitizeLabel(body.label);
  const email = typeof body.email === "string" && body.email.trim() ? body.email.trim() : null;

  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;

  // Creation order (§8): the D1 row first — it is authoritative for
  // existence. If DO init then fails, we have a valid pin with no position
  // yet, which the self-healing path repairs on first view.
  let slug = "";
  let secret = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    slug = generateSlug();
    secret = generateSecret();
    try {
      await env.DB.prepare(
        "INSERT INTO pins (slug, secret_hash, label, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, 'active')",
      )
        .bind(slug, await hashSecret(secret), label, now, expiresAt)
        .run();
      break;
    } catch (err) {
      if (attempt === 4 || !String(err).includes("UNIQUE")) throw err;
      // 60-bit collision — try a fresh slug.
    }
  }

  try {
    const stub = getPinStub(env, slug, request);
    await stub.configure(expiresAt);
    if (position) await stub.setPosition(position);
  } catch (err) {
    console.error(`DO init failed for ${slug.slice(0, SLUG_LENGTH)}; will self-heal on first view`, err instanceof Error ? err.message : err);
  }

  let emailResult: string | undefined;
  if (email) {
    emailResult = await sendRecoveryEmail(env, email, privateUrl(url.origin, slug, secret), expiresAt);
  }

  return json(
    {
      slug,
      secret,
      publicUrl: publicUrl(url.origin, slug),
      privateUrl: privateUrl(url.origin, slug, secret),
      expiresAt,
      ...(emailResult ? { email: emailResult } : {}),
    },
    { status: 201 },
  );
}

export async function getPosition(env: Env, slug: string): Promise<Response> {
  // This path must not touch D1 (§4/§8) — the DO alone decides what to serve.
  if (!isSlug(slug)) return errorJson(404, "not found");
  const result = await getPinStub(env, slug).getPosition();
  if ("gone" in result) return new Response(null, { status: 410 });
  if ("pending" in result) return new Response(null, { status: 204 });
  return json(result, { headers: { "Cache-Control": "no-store" } });
}

export async function setPosition(request: Request, env: Env, slug: string): Promise<Response> {
  if (killSwitchOn(env)) return errorJson(503, "updates are temporarily disabled");
  const secret = request.headers.get("X-Pin-Secret");
  const auth = await authorize(env, slug, secret);
  if ("response" in auth) return auth.response;
  const row = auth.row;
  const now = Date.now();
  if (row.status !== "active" || row.expires_at <= now) return errorJson(410, "this share has ended");

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = parsePosition(body);
  if ("error" in parsed) return errorJson(400, parsed.error);

  const stub = getPinStub(env, slug, request);
  let result = await stub.setPosition(parsed);
  if ("gone" in result) {
    // Self-heal (§7): D1 says active but the DO lost its configuration.
    if (row.expires_at > now) {
      await stub.configure(row.expires_at);
      result = await stub.setPosition(parsed);
    }
  }
  if ("gone" in result) return errorJson(410, "this share has ended");
  return json({ ok: true, at: result.at });
}

export async function getMeta(request: Request, env: Env, slug: string): Promise<Response> {
  const auth = await authorize(env, slug, request.headers.get("X-Pin-Secret"));
  if ("response" in auth) return auth.response;
  const row = auth.row;
  return json({
    slug: row.slug,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  });
}

export async function patchPin(request: Request, env: Env, slug: string): Promise<Response> {
  if (killSwitchOn(env)) return errorJson(503, "updates are temporarily disabled");
  const auth = await authorize(env, slug, request.headers.get("X-Pin-Secret"));
  if ("response" in auth) return auth.response;
  const row = auth.row;
  const now = Date.now();
  if (row.status !== "active" || row.expires_at <= now) return errorJson(410, "this share has ended");

  const body = await readJsonBody(request);
  if (body instanceof Response) return body;

  const wantsLabel = "label" in body;
  const label = wantsLabel ? sanitizeLabel(body.label) : undefined;
  const wantsTtl = "ttl" in body && body.ttl !== undefined;
  let newExpiresAt: number | null = null;
  if (wantsTtl) {
    const ttl = body.ttl;
    if (typeof ttl !== "number" || !TTL_OPTIONS_SECONDS.includes(ttl as (typeof TTL_OPTIONS_SECONDS)[number])) {
      return errorJson(400, `ttl must be one of ${TTL_OPTIONS_SECONDS.join(", ")}`);
    }
    // "Extend" semantics: the chosen duration is added to whatever remains,
    // capped at the hard 7-day maximum from now.
    newExpiresAt = Math.min(Math.max(now, row.expires_at) + ttl * 1000, now + MAX_TTL_MS);
  }

  if (newExpiresAt !== null && newExpiresAt < row.expires_at) {
    // Shortening reduces access: apply to the DO first, then D1 (§8).
    await getPinStub(env, slug, request).configure(newExpiresAt);
    await updatePinRow(env, slug, newExpiresAt, label);
  } else if (newExpiresAt !== null) {
    // Extending widens access: D1 first, then the DO. If the second step
    // fails, the pin still expires at the old, earlier time.
    await updatePinRow(env, slug, newExpiresAt, label);
    await getPinStub(env, slug, request).configure(newExpiresAt);
  } else if (wantsLabel) {
    await env.DB.prepare("UPDATE pins SET label = ? WHERE slug = ?").bind(label, slug).run();
  } else {
    return errorJson(400, "nothing to update");
  }

  const updated = await findPin(env, slug);
  return json({ ok: true, label: updated?.label ?? null, expiresAt: updated?.expires_at ?? row.expires_at });
}

async function updatePinRow(
  env: Env,
  slug: string,
  expiresAt: number | null,
  label: string | null | undefined,
): Promise<void> {
  if (expiresAt !== null && label !== undefined) {
    await env.DB.prepare("UPDATE pins SET expires_at = ?, label = ? WHERE slug = ?")
      .bind(expiresAt, label, slug)
      .run();
  } else if (expiresAt !== null) {
    await env.DB.prepare("UPDATE pins SET expires_at = ? WHERE slug = ?").bind(expiresAt, slug).run();
  } else if (label !== undefined) {
    await env.DB.prepare("UPDATE pins SET label = ? WHERE slug = ?").bind(label, slug).run();
  }
}

export async function stopPin(request: Request, env: Env, slug: string): Promise<Response> {
  const auth = await authorize(env, slug, request.headers.get("X-Pin-Secret"));
  if ("response" in auth) return auth.response;

  // Stop is never blocked by KILL_SWITCH: stopping an existing share is
  // always the privacy-positive action (§17 gates creation and movement).
  // Reduce-access ordering (§8): wipe the DO first — the stop control has to
  // actually stop things — then tombstone the row so viewers get 410 not 404.
  await getPinStub(env, slug, request).stop();
  await env.DB.prepare("UPDATE pins SET status = 'stopped' WHERE slug = ?").bind(slug).run();
  return new Response(null, { status: 204 });
}

export async function rotateSecret(request: Request, env: Env, url: URL, slug: string): Promise<Response> {
  if (killSwitchOn(env)) return errorJson(503, "updates are temporarily disabled");
  const auth = await authorize(env, slug, request.headers.get("X-Pin-Secret"));
  if ("response" in auth) return auth.response;

  const secret = generateSecret();
  await env.DB.prepare("UPDATE pins SET secret_hash = ? WHERE slug = ?")
    .bind(await hashSecret(secret), slug)
    .run();
  // Takes effect immediately by construction: authorisation is read from D1
  // on every call, so there is no cache to invalidate.
  return json({ ok: true, secret, privateUrl: privateUrl(url.origin, slug, secret) });
}
