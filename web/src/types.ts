/** Mirrors src/api/config.ts on the worker — keep the two in sync. */
export interface AppConfig {
  basemap: { kind: "pmtiles"; tilesUrl: string } | { kind: "style"; url: string };
  mapBounds: [[number, number], [number, number]] | null;
  mapMaxZoom: number | null;
  turnstileSiteKey: string | null;
  abuseEmail: string | null;
  privacyEmail: string | null;
}

export interface BootConfig {
  mode: "create" | "view" | "control";
  slug?: string;
  label?: string | null;
  expiresAt?: number;
  ended?: boolean;
}

export interface Position {
  lat: number;
  lng: number;
  accuracy: number | null;
  /** Server clock at the last update. */
  at: number;
  /** Server clock at the moment of the response (viewer poll). */
  now?: number;
}

export interface PinMeta {
  slug: string;
  label: string | null;
  status: "active" | "stopped";
  createdAt: number;
  expiresAt: number;
}

export interface CreatedPin {
  slug: string;
  secret: string;
  publicUrl: string;
  privateUrl: string;
  expiresAt: number;
  email?: string;
}

export interface SavedPin {
  slug: string;
  secret: string;
  label: string | null;
  createdAt: number;
  expiresAt: number;
  /** Pin position at creation — the display name fallback for untitled pins. */
  lat?: number;
  lng?: number;
}
