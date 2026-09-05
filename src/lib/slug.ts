/**
 * Slugs: 12 characters of Crockford base32 (no I/L/O/U) = ~60 bits.
 * With no discovery surface, this entropy is the entire security model
 * — do not shorten it without a deliberate review.
 */
export const SLUG_LENGTH = 12;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const SLUG_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

export function generateSlug(): string {
  // 5 bits per character × 12 = 60 bits of entropy.
  const bytes = new Uint8Array(SLUG_LENGTH);
  crypto.getRandomValues(bytes);
  let slug = "";
  for (let i = 0; i < SLUG_LENGTH; i++) slug += ALPHABET[bytes[i] & 31];
  return slug;
}

export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}
