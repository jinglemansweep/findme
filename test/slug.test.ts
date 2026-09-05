import { describe, expect, it } from "vitest";
import { generateSlug, isSlug, SLUG_LENGTH } from "../src/lib/slug";

describe("slugs", () => {
  it("generates 12-character Crockford base32 slugs", () => {
    for (let i = 0; i < 200; i++) {
      const slug = generateSlug();
      expect(slug).toHaveLength(SLUG_LENGTH);
      expect(slug).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    }
  });

  it("never contains the excluded characters I L O U", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateSlug()).not.toMatch(/[ILOU]/);
    }
  });

  it("produces varied slugs (60 bits — the whole security model)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateSlug());
    expect(seen.size).toBe(100);
  });

  it("validates slugs", () => {
    expect(isSlug("0123456789AB")).toBe(true);
    expect(isSlug("abcdefghijkl")).toBe(false); // lowercase
    expect(isSlug("0123456789AI")).toBe(false); // excluded char
    expect(isSlug("0123456789A")).toBe(false); // too short
    expect(isSlug("0123456789ABC")).toBe(false); // too long
    expect(isSlug("0123456789A-")).toBe(false);
    expect(isSlug("")).toBe(false);
  });
});
