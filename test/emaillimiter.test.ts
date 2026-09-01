import { describe, expect, it } from "vitest";
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";

const e = env as unknown as Env;

describe("EmailLimiter", () => {
  it("allows a few sends per window then blocks", async () => {
    const stub = e.EMAIL_LIMITER.get(e.EMAIL_LIMITER.idFromName("test-recipient-hash"));
    expect(await stub.check()).toEqual({ ok: true, remaining: 2 });
    expect(await stub.check()).toEqual({ ok: true, remaining: 1 });
    expect(await stub.check()).toEqual({ ok: true, remaining: 0 });
    expect(await stub.check()).toEqual({ ok: false, remaining: 0 });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  });

  it("deletes itself when the window ends (§11: never accumulate DO storage)", async () => {
    const stub = e.EMAIL_LIMITER.get(e.EMAIL_LIMITER.idFromName("another-recipient"));
    await stub.check();
    await runDurableObjectAlarm(stub);
    // A fresh window after self-deletion.
    expect(await stub.check()).toEqual({ ok: true, remaining: 2 });
  });

  it("tracks recipients independently (keyed by sha256 of the address)", async () => {
    const a = e.EMAIL_LIMITER.get(e.EMAIL_LIMITER.idFromName("hash-a"));
    const b = e.EMAIL_LIMITER.get(e.EMAIL_LIMITER.idFromName("hash-b"));
    expect((await a.check()).ok).toBe(true);
    expect((await b.check()).ok).toBe(true);
    await runDurableObjectAlarm(a);
    await runDurableObjectAlarm(b);
  });
});
