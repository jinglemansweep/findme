import { describe, expect, it } from "vitest";
import { generateSecret, hashSecret, timingSafeEqual } from "../src/lib/auth";

describe("secrets", () => {
  it("generates 32-byte base64url secrets", () => {
    for (let i = 0; i < 50; i++) {
      const secret = generateSecret();
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("hashes deterministically with sha-256 hex", async () => {
    const a = await hashSecret("s_abc");
    const b = await hashSecret("s_abc");
    const c = await hashSecret("s_abd");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("compares equal strings as equal", () => {
    expect(timingSafeEqual("deadbeef".repeat(8), "deadbeef".repeat(8))).toBe(true);
  });

  it("rejects differing strings without early exit", () => {
    expect(timingSafeEqual("deadbeef".repeat(8), "deadbeef".repeat(7) + "ee")).toBe(false);
    expect(timingSafeEqual("a", "ab")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});
