import type { Env } from "../env";
import { json } from "../lib/http";
import { archiveAvailable } from "../tiles/routes";

/**
 * Phase-1 development basemap: a permissive, key-less vector style so the map
 * works before the PMTiles archive is uploaded to R2. Once TILES.md §3 is
 * done, the config flips to the PMTiles proxy with no code change.
 */
const FALLBACK_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

export interface AppConfig {
  basemap:
    | { kind: "pmtiles"; tilesUrl: string }
    | { kind: "style"; url: string };
  /** [[west, south], [east, north]] — the archive's coverage; constrains
   *  panning so users never see blank ocean outside the extract. */
  mapBounds: [[number, number], [number, number]] | null;
  mapMaxZoom: number | null;
  turnstileSiteKey: string | null;
  abuseEmail: string | null;
  privacyEmail: string | null;
  /** Non-production marker (staging's "beta"); the SPA labels the create
   *  page with it — worker-rendered pages are labelled server-side. */
  envLabel: string | null;
}

function parseBounds(raw: string | undefined): [[number, number], [number, number]] | null {
  if (!raw) return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = parts;
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}

export async function handleConfig(env: Env): Promise<Response> {
  let basemap: AppConfig["basemap"] = { kind: "style", url: FALLBACK_STYLE_URL };
  let mapBounds: AppConfig["mapBounds"] = null;
  if (env.PMTILES_KEY && (await archiveAvailable(env))) {
    basemap = { kind: "pmtiles", tilesUrl: "/tiles/tiles.json" };
    mapBounds = parseBounds(env.MAP_BOUNDS);
  }
  const config: AppConfig = {
    basemap,
    mapBounds,
    mapMaxZoom: Number.parseInt(env.TILES_MAXZOOM ?? "", 10) || null,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
    abuseEmail: env.ABUSE_EMAIL ?? null,
    privacyEmail: env.PRIVACY_EMAIL ?? null,
    envLabel: env.ENV_LABEL || null,
  };
  return json(config, { headers: { "Cache-Control": "public, max-age=60" } });
}
