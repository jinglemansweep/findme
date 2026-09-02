import type { AppConfig } from "./types";

const FALLBACK_CONFIG: AppConfig = {
  basemap: { kind: "style", url: "https://tiles.openfreemap.org/styles/liberty" },
  mapBounds: null,
  mapMaxZoom: null,
  turnstileSiteKey: null,
  abuseEmail: null,
  privacyEmail: null,
  envLabel: null,
};

export async function fetchAppConfig(): Promise<AppConfig> {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return FALLBACK_CONFIG;
    return (await res.json()) as AppConfig;
  } catch {
    return FALLBACK_CONFIG;
  }
}

export { FALLBACK_CONFIG };
