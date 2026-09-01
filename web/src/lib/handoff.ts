import type { Position } from "../types";

export interface HandoffTarget {
  name: string;
  url: string;
}

/**
 * Map hand-off links (PLAN.md §12). Detect the platform and surface the two
 * or three that make sense — not all five.
 */
export function handoffTargets(
  position: { lat: number; lng: number },
  label: string | null,
): HandoffTarget[] {
  const lat = position.lat.toFixed(6);
  const lng = position.lng.toFixed(6);
  const name = encodeURIComponent(label?.slice(0, 60) || "Shared location");
  const platform = detectPlatform();

  const google = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  const apple = `https://maps.apple.com/?ll=${lat},${lng}&q=${name}`;
  const geo = `geo:${lat},${lng}?q=${lat},${lng}(${name})`;
  const osm = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
  const waze = `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;

  if (platform === "ios") return [{ name: "Apple Maps", url: apple }, { name: "Google Maps", url: google }];
  if (platform === "android")
    return [
      { name: "Google Maps", url: google },
      { name: "Waze", url: waze },
      { name: "Open in maps app", url: geo },
    ];
  return [{ name: "Google Maps", url: google }, { name: "OpenStreetMap", url: osm }];
}

export function detectPlatform(): "ios" | "android" | "other" {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}
