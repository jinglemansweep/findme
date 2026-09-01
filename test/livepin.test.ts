import { describe, expect, it } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import type { LivePin } from "../src/do/LivePin";

const e = env as unknown as Env;

function stubFor(slug: string) {
  return e.LIVE_PIN.get(e.LIVE_PIN.idFromName(slug));
}

describe("LivePin", () => {
  it("serves pending, then position, with a server clock", async () => {
    const stub = stubFor("TESTPIN000001");
    await stub.configure(Date.now() + 60_000);

    expect(await stub.getPosition()).toEqual({ pending: true });

    await stub.setPosition({ lat: 51.5, lng: -0.1, accuracy: 30 });
    const result = await stub.getPosition();
    expect("lat" in result).toBe(true);
    if (!("lat" in result)) return;
    expect(result).toMatchObject({ lat: 51.5, lng: -0.1, accuracy: 30 });
    expect(result.now).toBeGreaterThanOrEqual(result.at);
    await stub.stop();
  });

  it("enforces expiry on read, before the alarm fires (§7)", async () => {
    const stub = stubFor("TESTPIN000002");
    await stub.configure(Date.now() + 60_000);
    await stub.setPosition({ lat: 1, lng: 2, accuracy: null });

    // Backdate the expiry: even if the alarm is delayed, reads must fail.
    await stub.configure(Date.now() - 1);
    expect(await stub.getPosition()).toEqual({ gone: true });
    expect(await stub.setPosition({ lat: 3, lng: 4, accuracy: null })).toEqual({ gone: true });
  });

  it("wipes storage on alarm, idempotently", async () => {
    const stub = stubFor("TESTPIN000003");
    await stub.configure(Date.now() + 60_000);
    await stub.setPosition({ lat: 1, lng: 2, accuracy: null });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getPosition()).toEqual({ gone: true });
    // alarm() must be safe to retry (at-least-once execution, §8).
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("stop() clears the alarm as well as the storage", async () => {
    const stub = stubFor("TESTPIN000004");
    await stub.configure(Date.now() + 60_000);
    await stub.setPosition({ lat: 1, lng: 2, accuracy: null });
    await stub.stop();

    expect(await runDurableObjectAlarm(stub)).toBe(false); // deleteAlarm worked
  });

  it("ensureConfigured only writes when there is nothing to heal", async () => {
    const stub = stubFor("TESTPIN000005");
    expect(await stub.ensureConfigured(Date.now() + 60_000)).toEqual({ configured: true });
    expect(await stub.ensureConfigured(Date.now() + 120_000)).toEqual({ configured: false });
    // The first expiry stands — ensureConfigured never shortens or extends.
    const storage = await runInDurableObject(stub, async (_instance: LivePin, state: DurableObjectState) => {
      return state.storage.get<{ at: number }>("exp");
    });
    expect(storage!.at).toBeLessThanOrEqual(Date.now() + 60_000);
    await stub.stop();
  });

  it("stores the versioned shape from release one (docs/MIGRATIONS.md §6)", async () => {
    const stub = stubFor("TESTPIN000006");
    await stub.configure(Date.now() + 60_000);
    await stub.setPosition({ lat: 1, lng: 2, accuracy: null });
    const pos = await runInDurableObject(stub, async (_instance: LivePin, state: DurableObjectState) => {
      return state.storage.get<{ v?: number }>("pos");
    });
    expect(pos!.v).toBe(1);
    await stub.stop();
  });
});
