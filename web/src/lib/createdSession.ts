import type { CreatedPin } from "../types";

// The "your share is live" panel survives a round-trip to /privacy (and an
// accidental refresh): the created pin is kept in sessionStorage until the
// panel is closed or it expires. The control page clears it via
// clearCreatedSessionFor when the share is stopped, ends, or its secret is
// rotated — otherwise the create page would resurrect a dead panel.
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

/** Drop the stored panel, but only if it refers to this pin. */
export function clearCreatedSessionFor(slug: string): void {
  if (loadCreatedSession()?.slug === slug) storeCreatedSession(null);
}
