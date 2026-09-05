import type { CreatedPin } from "../types";

// The created pin is kept in sessionStorage so the create page can funnel
// straight back into the control page — right after creation, and after a
// refresh or a round-trip to /privacy while the share is live. The control
// page clears it via clearCreatedSessionFor when the share is stopped, ends,
// or its secret is rotated — otherwise the create page would redirect to a
// dead control link.
const CREATED_KEY = "findme.created.v1";

export function loadCreatedSession(): CreatedPin | null {
  try {
    const raw = sessionStorage.getItem(CREATED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CreatedPin;
    return parsed.expiresAt > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

export function storeCreatedSession(pin: CreatedPin | null): void {
  try {
    if (pin) sessionStorage.setItem(CREATED_KEY, JSON.stringify(pin));
    else sessionStorage.removeItem(CREATED_KEY);
  } catch {
    // Private browsing / storage full — the pin is still in the saved list.
  }
}

/** Drop the stored session, but only if it refers to this pin. */
export function clearCreatedSessionFor(slug: string): void {
  if (loadCreatedSession()?.slug === slug) storeCreatedSession(null);
}

// The recovery-email result is shown on the control page after the redirect
// (the panel it used to appear on is gone). Timestamp-stamped rather than
// read-once so the control page can read it without clearing — StrictMode
// double-mounts and refreshes stay harmless, and stale entries age out.
const EMAIL_NOTICE_KEY = "findme.emailNotice.v1";
const EMAIL_NOTICE_MAX_AGE_MS = 2 * 60_000;

export function storeEmailNotice(slug: string, status: string): void {
  try {
    sessionStorage.setItem(EMAIL_NOTICE_KEY, JSON.stringify({ slug, status, at: Date.now() }));
  } catch {
    // Purely informational — fine to lose.
  }
}

export function loadEmailNotice(slug: string): string | null {
  try {
    const raw = sessionStorage.getItem(EMAIL_NOTICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { slug: string; status: string; at: number };
    return parsed.slug === slug && Date.now() - parsed.at < EMAIL_NOTICE_MAX_AGE_MS ? parsed.status : null;
  } catch {
    return null;
  }
}
