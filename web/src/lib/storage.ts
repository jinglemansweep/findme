import type { SavedPin } from "../types";

/**
 * The browser stores each pin's secret link locally so the user can return to
 * it (this is the "On your device" section of the privacy notice). It never
 * leaves the device and cannot be recovered by us.
 */
const KEY = "findme.pins.v1";

export function listSavedPins(): SavedPin[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedPin[];
    if (!Array.isArray(parsed)) return [];
    // Drop entries that have expired — a secret past its TTL is worthless.
    const now = Date.now();
    return parsed.filter((p) => p && typeof p.slug === "string" && p.expiresAt > now);
  } catch {
    return [];
  }
}

function write(pins: SavedPin[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pins));
  } catch {
    // Private browsing / storage full — recovery via email still exists.
  }
}

export function savePin(pin: SavedPin): void {
  const pins = listSavedPins().filter((p) => p.slug !== pin.slug);
  pins.unshift(pin);
  write(pins);
}

export function updateSavedPin(slug: string, changes: Partial<SavedPin>): SavedPin | null {
  const pins = listSavedPins();
  let updated: SavedPin | null = null;
  for (const pin of pins) {
    if (pin.slug === slug) {
      Object.assign(pin, changes);
      updated = pin;
    }
  }
  write(pins);
  return updated;
}

export function getSavedPin(slug: string): SavedPin | null {
  return listSavedPins().find((p) => p.slug === slug) ?? null;
}

export function removeSavedPin(slug: string): void {
  write(listSavedPins().filter((p) => p.slug !== slug));
}
