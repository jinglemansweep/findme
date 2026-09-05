import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { ipHash, rateLimitOk } from "../src/lib/ratelimit";
import { withEnvLabel } from "../src/lib/envLabel";

const e = env as unknown as Env;

describe("ipHash", () => {
  const req = (ip: string) => new Request("http://localhost/", { headers: { "CF-Connecting-IP": ip } });

  it("is deterministic per salt+ip and hex-shaped", async () => {
    const a = await ipHash({ ...e, IP_SALT: "unit-salt" }, req("203.0.113.9"));
    const b = await ipHash({ ...e, IP_SALT: "unit-salt" }, req("203.0.113.9"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it("separates salts and IPs", async () => {
    const base = await ipHash({ ...e, IP_SALT: "unit-salt" }, req("203.0.113.9"));
    expect(await ipHash({ ...e, IP_SALT: "other-salt" }, req("203.0.113.9"))).not.toBe(base);
    expect(await ipHash({ ...e, IP_SALT: "unit-salt" }, req("203.0.113.10"))).not.toBe(base);
  });
});

describe("rateLimitOk", () => {
  it("fails open when the binding errors", async () => {
    const broken = {
      limit: async () => {
        throw new Error("binding unavailable");
      },
    } as unknown as RateLimit;
    expect(await rateLimitOk(broken, "k")).toBe(true);
  });

  it("reports the limiter verdict otherwise", async () => {
    const deny = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    expect(await rateLimitOk(deny, "k")).toBe(false);
    const allow = { limit: async () => ({ success: true }) } as unknown as RateLimit;
    expect(await rateLimitOk(allow, "k")).toBe(true);
  });
});

describe("withEnvLabel", () => {
  const page = `<!doctype html><html><head><title>Find Me</title></head><body><a class="brand" href="/">Find&nbsp;Me</a></body></html>`;

  it("labels the title and brand of HTML responses", async () => {
    const res = await withEnvLabel(
      new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
      "beta",
    );
    const body = await res.text();
    expect(body).toContain("Find Me (beta)</title>");
    expect(body).toContain('<span class="env-badge">beta</span>');
  });

  it("leaves non-HTML responses alone", async () => {
    const res = await withEnvLabel(
      new Response('{"x":1}', { headers: { "Content-Type": "application/json" } }),
      "beta",
    );
    expect(await res.text()).toBe('{"x":1}');
  });
});
