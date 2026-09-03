import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { redirectToHttps } from "../src/lib/http";

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
    expect(pin.privateUrl).toContain("#s_"); // secret lives in the fragment (§3)
    expect(pin.expiresAt).toBeGreaterThan(Date.now());

    // Position is live immediately when supplied at creation.
    const pos = await fetchJson(`/api/pins/${pin.slug}/position`);
    expect(pos.status).toBe(200);
    expect(pos.body.lat).toBeCloseTo(51.5007);
    expect(pos.body.lng).toBeCloseTo(-0.1246);
    expect(pos.body.accuracy).toBe(25);
    expect(pos.body.at).toBeLessThanOrEqual(pos.body.now); // server-supplied now (§4)

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

    // Stop wipes the DO and tombstones the row (§8 ordering).
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
  });

  it("caps labels at ~140 characters and strips control characters", async () => {
    const longLabel = "a".repeat(300);
    const pin = await createPin({ label: longLabel });
    const meta = await fetchJson(`/api/pins/${pin.slug}`, { headers: { "X-Pin-Secret": pin.secret } });
    expect(meta.body.label).toHaveLength(140);
    expect(meta.body.label).toBe("a".repeat(140));
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

  it("rate-limits pin creation per IP (native ratelimits, §11)", async () => {
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
    const html = await res.text();
    expect(html).not.toContain("og:");
    expect(html).not.toContain('property="og');
    expect(html).not.toContain("Meet me at the car"); // no label in control HTML
    // The anti-footgun warning (§3) lives as a sticky header of the control
    // card in the SPA; the server shell keeps a no-JavaScript variant.
    expect(html).not.toContain("control-banner");
    expect(html).toContain("Never paste");
    expect(html).toContain("This page needs JavaScript");
  });

  it("returns 404 for unknown slugs and 410 for stopped pins", async () => {
    expect((await fetchPage("/0123456789AB")).status).toBe(404);
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
