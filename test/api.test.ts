import { describe, expect, it } from "vitest";
import { exports, env } from "cloudflare:workers";
import type { Env } from "../src/env";
import {
  createPin as createPinHandler,
  patchPin as patchPinHandler,
  rotateSecret as rotateSecretHandler,
  setPosition as setPositionHandler,
  stopPin as stopPinHandler,
} from "../src/api/pins";
import { killSwitchOn, redirectToHttps } from "../src/lib/http";

const e = env as unknown as Env;

// Each request uses a distinct CF-Connecting-IP: the native rate limiters
// key on its hash, and the suite would otherwise exhaust the per-IP creation
// budget (10/min) within a single file.
let requestSeq = 0;

async function fetchJson(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  requestSeq += 1;
  const headers = new Headers(init.headers);
  if (!headers.has("CF-Connecting-IP")) {
    headers.set("CF-Connecting-IP", `127.0.0.${(requestSeq % 250) + 1}`);
  }
  const res = await exports.default.fetch(new Request(`http://localhost${path}`, { ...init, headers }));
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function post(path: string, body: unknown, secret?: string): Promise<{ status: number; body: any }> {
  return fetchJson(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "X-Pin-Secret": secret } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function fetchPage(path: string): Promise<Response> {
  requestSeq += 1;
  return exports.default.fetch(
    new Request(`http://localhost${path}`, {
      headers: { "CF-Connecting-IP": `127.0.0.${(requestSeq % 250) + 1}` },
    }),
  );
}

interface CreatedPin {
  slug: string;
  secret: string;
  publicUrl: string;
  privateUrl: string;
  expiresAt: number;
}

async function createPin(overrides: Record<string, unknown> = {}): Promise<CreatedPin> {
  const { status, body } = await post("/api/pins", {
    ttl: 3600,
    label: "Meet me at the car",
    ...overrides,
  });
  expect(status).toBe(201);
  return body as CreatedPin;
}

describe("pin lifecycle", () => {
  it("creates a pin, updates and reads its position, then stops it", async () => {
    const pin = await createPin({ lat: 51.5007, lng: -0.1246, accuracy: 25 });

    expect(pin.slug).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(pin.publicUrl).toBe(`http://localhost/${pin.slug}`);
    expect(pin.privateUrl).toBe(`http://localhost/u/${pin.slug}#s_${pin.secret}`);
    expect(pin.privateUrl).toContain("#s_"); // secret lives in the fragment
    expect(pin.expiresAt).toBeGreaterThan(Date.now());

    // Position is live immediately when supplied at creation.
    const pos = await fetchJson(`/api/pins/${pin.slug}/position`);
    expect(pos.status).toBe(200);
    expect(pos.body.lat).toBeCloseTo(51.5007);
    expect(pos.body.lng).toBeCloseTo(-0.1246);
    expect(pos.body.accuracy).toBe(25);
    expect(pos.body.at).toBeLessThanOrEqual(pos.body.now); // server-supplied now

    // Manual update from the sender.
    const update = await post(
      `/api/pins/${pin.slug}/position`,
      { lat: 51.51, lng: -0.13, accuracy: 12 },
      pin.secret,
    );
    expect(update.status).toBe(200);
    expect(update.body.at).toBeGreaterThan(0);

    const updated = await fetchJson(`/api/pins/${pin.slug}/position`);
    expect(updated.body.lat).toBeCloseTo(51.51);

    // Wrong secret is rejected.
    const bad = await post(`/api/pins/${pin.slug}/position`, { lat: 1, lng: 1 }, "wrong-secret");
    expect(bad.status).toBe(401);
    const none = await post(`/api/pins/${pin.slug}/position`, { lat: 1, lng: 1 });
    expect(none.status).toBe(401);

    // Stop wipes the DO and tombstones the row, in that order.
    const stop = await fetchJson(`/api/pins/${pin.slug}`, { method: "DELETE", headers: { "X-Pin-Secret": pin.secret } });
    expect(stop.status).toBe(204);
    expect((await fetchJson(`/api/pins/${pin.slug}/position`)).status).toBe(410);
  });

  it("returns 204 while waiting for a first position", async () => {
    const pin = await createPin(); // no lat/lng
    const res = await fetchPage(`/api/pins/${pin.slug}/position`);
    expect(res.status).toBe(204);
    await fetchJson(`/api/pins/${pin.slug}`, { method: "DELETE", headers: { "X-Pin-Secret": pin.secret } });
  });

  it("validates the request body", async () => {
    const badTtl = await post("/api/pins", { ttl: 12345 });
    expect(badTtl.status).toBe(400);
    const badPos = await post("/api/pins", { ttl: 3600, lat: 999, lng: 0 });
    expect(badPos.status).toBe(400);
    const badJson = await fetchJson("/api/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
    // A JSON body that is not an object is rejected just the same.
    const arrayBody = await post("/api/pins", [1, 2, 3]);
    expect(arrayBody.status).toBe(400);
    expect(arrayBody.body.error).toBe("body must be a JSON object");
  });

  it("rejects oversized bodies before parsing", async () => {
    const big = await post("/api/pins", { ttl: 900, label: "a".repeat(5000) });
    expect(big.status).toBe(413);
  });

  it("caps labels at ~140 characters and strips control characters", async () => {
    const longLabel = "a".repeat(300);
    const pin = await createPin({ label: longLabel });
    const meta = await fetchJson(`/api/pins/${pin.slug}`, { headers: { "X-Pin-Secret": pin.secret } });
    expect(meta.body.label).toHaveLength(140);
    expect(meta.body.label).toBe("a".repeat(140));
  });

  it("neutralises control characters in labels", async () => {
    const pin = await createPin({ label: "  Line1\nLine2\x00\x1fEnd\tTab  " });
    const meta = await fetchJson(`/api/pins/${pin.slug}`, { headers: { "X-Pin-Secret": pin.secret } });
    // Every control character became a space; the result is trimmed.
    expect(meta.body.label).toBe("Line1 Line2  End Tab");
  });

  it("caps labels by code points, not UTF-16 units", async () => {
    // Astral characters are two UTF-16 units each — the cap is 140 characters.
    const pin = await createPin({ label: "\u{1D306}".repeat(150) });
    const meta = await fetchJson(`/api/pins/${pin.slug}`, { headers: { "X-Pin-Secret": pin.secret } });
    expect(Array.from(meta.body.label as string)).toHaveLength(140);
  });

  it("treats a blank label as absent", async () => {
    const pin = await createPin({ label: "  \n\t " });
    const meta = await fetchJson(`/api/pins/${pin.slug}`, { headers: { "X-Pin-Secret": pin.secret } });
    expect(meta.body.label).toBeNull();
  });

  it("extends the TTL (D1 first) and edits the label", async () => {
    const pin = await createPin({ ttl: 900 });
    const before = await fetchJson(`/api/pins/${pin.slug}`, { headers: { "X-Pin-Secret": pin.secret } });
    const beforeRemaining = before.body.expiresAt - Date.now();

    const patch = await fetchJson(`/api/pins/${pin.slug}`, {
      method: "PATCH",
      headers: { "X-Pin-Secret": pin.secret, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 3600, label: "Moved to the pub" }),
    });
    expect(patch.status).toBe(200);
    expect(patch.body.label).toBe("Moved to the pub");
    expect(patch.body.expiresAt - Date.now()).toBeGreaterThan(beforeRemaining + 3000 * 1000);
  });

  it("caps extension at the 7-day maximum from now", async () => {
    // The privacy notice promises no pin outlives 7 days — even a maximal
    // pin extended by another 7 days must not pass that horizon.
    const pin = await createPin({ ttl: 604_800 });
    const before = await fetchJson(`/api/pins/${pin.slug}`, { headers: { "X-Pin-Secret": pin.secret } });

    const patch = await fetchJson(`/api/pins/${pin.slug}`, {
      method: "PATCH",
      headers: { "X-Pin-Secret": pin.secret, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 604_800 }),
    });
    expect(patch.status).toBe(200);
    expect(patch.body.expiresAt).toBeGreaterThan(before.body.expiresAt - 1);
    expect(patch.body.expiresAt).toBeLessThanOrEqual(Date.now() + 604_800_000 + 1_000);
  });

  it("adds the requested duration to whatever remains (never shortens)", async () => {
    // Extension semantics: a 15-minute pin extended by 15 minutes has ~30
    // minutes left — the ttl is added, not reset, and can only ever grow.
    const pin = await createPin({ ttl: 900 });
    const patch = await fetchJson(`/api/pins/${pin.slug}`, {
      method: "PATCH",
      headers: { "X-Pin-Secret": pin.secret, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 900 }),
    });
    expect(patch.status).toBe(200);
    expect(patch.body.expiresAt).toBeGreaterThan(Date.now() + 1_700_000);
    expect(patch.body.expiresAt).toBeLessThanOrEqual(Date.now() + 1_810_000);
  });

  it("validates PATCH bodies", async () => {
    const pin = await createPin();
    const headers = { "X-Pin-Secret": pin.secret, "Content-Type": "application/json" };
    const badTtl = await fetchJson(`/api/pins/${pin.slug}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ ttl: 12345 }),
    });
    expect(badTtl.status).toBe(400);
    const nothing = await fetchJson(`/api/pins/${pin.slug}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({}),
    });
    expect(nothing.status).toBe(400);
  });

  it("clears the label with an explicit null", async () => {
    const pin = await createPin({ label: "temporary" });
    const patch = await fetchJson(`/api/pins/${pin.slug}`, {
      method: "PATCH",
      headers: { "X-Pin-Secret": pin.secret, "Content-Type": "application/json" },
      body: JSON.stringify({ label: null }),
    });
    expect(patch.status).toBe(200);
    expect(patch.body.label).toBeNull();
  });

  it("rotates the secret; the old secret stops working immediately", async () => {
    const pin = await createPin();
    const rotate = await post(`/api/pins/${pin.slug}/rotate`, {}, pin.secret);
    expect(rotate.status).toBe(200);
    const newSecret: string = rotate.body.secret;

    const oldMeta = await fetchJson(`/api/pins/${pin.slug}`, { headers: { "X-Pin-Secret": pin.secret } });
    expect(oldMeta.status).toBe(401);

    const newMeta = await fetchJson(`/api/pins/${pin.slug}`, { headers: { "X-Pin-Secret": newSecret } });
    expect(newMeta.status).toBe(200);
    expect(rotate.body.privateUrl).toBe(`http://localhost/u/${pin.slug}#s_${newSecret}`);
  });

  it("rate-limits pin creation per IP (native ratelimits)", async () => {
    const headers = { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" };
    let saw429 = false;
    for (let i = 0; i < 20 && !saw429; i++) {
      const { status } = await fetchJson("/api/pins", {
        method: "POST",
        headers,
        body: JSON.stringify({ ttl: 900 }),
      });
      saw429 = status === 429;
    }
    expect(saw429).toBe(true); // the 10/min budget ran out
  });

  it("404s invalid slugs; valid-but-unknown slugs read as gone (410)", async () => {
    expect((await fetchJson("/api/pins/0123456789AB/position")).status).toBe(410); // no exp in the DO
    expect((await fetchJson("/api/pins/not-a-slug/position")).status).toBe(404);
    const meta = await fetchJson("/api/pins/SHORTSLUG", { headers: { "X-Pin-Secret": "x" } });
    expect(meta.status).toBe(404);
  });
});

describe("kill switch", () => {
  it("gates creation, movement, edits and rotation — but never stop", async () => {
    const pin = await createPin({ ttl: 900, lat: 1, lng: 2 });
    const blocked = { ...e, KILL_SWITCH: "true" } as Env;
    const req = (method: string, path: string, body?: unknown, secret?: string) =>
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(secret ? { "X-Pin-Secret": secret } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

    // Handlers are called directly so the env var can be flipped per call.
    const created = await createPinHandler(req("POST", "/api/pins", { ttl: 900 }), blocked, new URL("http://localhost/"));
    expect(created.status).toBe(503);
    const moved = await setPositionHandler(
      req("POST", `/api/pins/${pin.slug}/position`, { lat: 3, lng: 4 }, pin.secret),
      blocked,
      pin.slug,
    );
    expect(moved.status).toBe(503);
    const patched = await patchPinHandler(req("PATCH", `/api/pins/${pin.slug}`, { label: "x" }, pin.secret), blocked, pin.slug);
    expect(patched.status).toBe(503);
    const rotated = await rotateSecretHandler(
      req("POST", `/api/pins/${pin.slug}/rotate`, {}, pin.secret),
      blocked,
      new URL("http://localhost/"),
      pin.slug,
    );
    expect(rotated.status).toBe(503);

    // Stop is exempt: ending a share is always the privacy-positive action.
    const stopped = await stopPinHandler(req("DELETE", `/api/pins/${pin.slug}`, undefined, pin.secret), blocked, pin.slug);
    expect(stopped.status).toBe(204);
  });

  it("parses the KILL_SWITCH values", () => {
    for (const v of ["1", "true", "on", "TRUE", " true "]) {
      expect(killSwitchOn({ KILL_SWITCH: v } as Env)).toBe(true);
    }
    for (const v of ["0", "false", "off", "", "yes?"]) {
      expect(killSwitchOn({ KILL_SWITCH: v } as Env)).toBe(false);
    }
    expect(killSwitchOn({} as Env)).toBe(false);
  });
});

describe("abuse limits", () => {
  it("rate-limits slug lookups on the page shells (enumeration defence)", async () => {
    const headers = { "CF-Connecting-IP": "198.51.100.7" };
    let saw429 = false;
    for (let i = 0; i < 80 && !saw429; i++) {
      const res = await exports.default.fetch(new Request("http://localhost/0123456789AB", { headers }));
      saw429 = res.status === 429;
    }
    expect(saw429).toBe(true); // the 60/min budget ran out
  });
});

describe("shells", () => {
  const evilLabel = `<script>alert("xss")</script>`;

  it("escapes the label in the public shell and keeps it out of meta tags", async () => {
    const pin = await createPin({ label: evilLabel });
    const res = await fetchPage(`/${pin.slug}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert");
    expect(html).toContain('property="og:title"'); // og tags exist…
    // …but the label must not appear inside any <meta> tag.
    const metaContents = html.match(/<meta[^>]*>/g)?.join("\n") ?? "";
    expect(metaContents).not.toContain("alert");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("serves the control shell with no-store, no-referrer, noindex and no OG", async () => {
    const pin = await createPin();
    const res = await fetchPage(`/u/${pin.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    // Framing and downgrade protection on every Worker-rendered page.
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    const html = await res.text();
    expect(html).not.toContain("og:");
    expect(html).not.toContain('property="og');
    expect(html).not.toContain("Meet me at the car"); // no label in control HTML
    // The anti-footgun warning lives as a sticky header of the control
    // card in the SPA; the server shell keeps a no-JavaScript variant.
    expect(html).not.toContain("control-banner");
    expect(html).toContain("Never paste");
    expect(html).toContain("This page needs JavaScript");
  });

  it("returns 404 for unknown slugs and 410 for stopped pins", async () => {
    const notFound = await fetchPage("/0123456789AB");
    expect(notFound.status).toBe(404);
    // The not-found card is fully server-rendered: booting the SPA over it
    // would flip it to a misleading "share has ended" (the DO reads 410 for a
    // never-configured slug).
    const notFoundHtml = await notFound.text();
    expect(notFoundHtml).not.toContain("assets/app.js");
    expect(notFoundHtml).toContain('href="https://github.com/jinglemansweep/findme"');
    expect((await fetchPage("/u/0123456789AB")).status).toBe(404);

    const pin = await createPin();
    await fetchJson(`/api/pins/${pin.slug}`, { method: "DELETE", headers: { "X-Pin-Secret": pin.secret } });
    const stopped = await fetchPage(`/${pin.slug}`);
    expect(stopped.status).toBe(410);
    expect(await stopped.text()).toContain("share has ended");
  });

  it("serves the privacy notice fully server-rendered (no SPA takeover)", async () => {
    const res = await fetchPage("/privacy");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("There are no accounts");
    expect(html).not.toContain("[DATE]");
    expect(html).toContain("abuse@appts.uk");
    // Hard-wrapped source lines join into one paragraph, not one <p> per line.
    expect(html).toContain("dedicated to that single pin");
    expect(html).toContain('class="button secondary small privacy-back"');
    // Including the bundle here would boot the create page over the article.
    expect(html).not.toContain("assets/app.js");
  });

  it("exposes the app config", async () => {
    const { status, body } = await fetchJson("/api/config");
    expect(status).toBe(200);
    expect(["pmtiles", "style"]).toContain(body.basemap.kind);
    expect(body.turnstileSiteKey).toBeNull();
  });
});

describe("http to https", () => {
  // The test harness rewrites non-localhost hosts before dispatch, so the
  // 308 is checked against the helper directly; the handler test pins the
  // localhost exemption that local dev (and this suite) rely on.
  it("308-redirects plain http, preserving path and query", () => {
    const res = redirectToHttps(new URL("http://find.appts.uk/0123456789AB?x=1"));
    expect(res?.status).toBe(308);
    expect(res?.headers.get("Location")).toBe("https://find.appts.uk/0123456789AB?x=1");
  });

  it("leaves already-https and local dev hosts alone", () => {
    expect(redirectToHttps(new URL("https://find.appts.uk/0123456789AB"))).toBeNull();
    expect(redirectToHttps(new URL("http://localhost/0123456789AB"))).toBeNull();
    expect(redirectToHttps(new URL("http://127.0.0.1:8787/0123456789AB"))).toBeNull();
  });

  it("does not redirect plain-http localhost through the handler", async () => {
    const res = await exports.default.fetch(new Request("http://localhost/0123456789AB"));
    expect([301, 302, 307, 308]).not.toContain(res.status);
  });
});
