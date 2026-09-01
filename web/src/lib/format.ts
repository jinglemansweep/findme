/** "just now", "40 seconds ago", "6 minutes ago", "2 hours ago", "3 days ago" */
export function relativeAge(ageMs: number): string {
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m === 1) return "1 minute ago";
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h === 1) return "1 hour ago";
  if (h < 48) return `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

/** "1h 23m", "2m 05s", "45s", "expired" — for countdowns. */
export function countdown(remainingMs: number): string {
  if (remainingMs <= 0) return "expired";
  const s = Math.floor(remainingMs / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function formatExpiry(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatCoords(lat: number, lng: number, accuracy: number | null): string {
  const pos = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  return accuracy != null ? `${pos} (±${Math.round(accuracy)} m)` : pos;
}
