import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

/**
 * MapLibre style for the Protomaps PMTiles basemap served from our own R2 via
 * /tiles/* (docs/TILES.md). Warm neutral palette; glyphs come from
 * /tiles/fonts/… (Noto Sans Regular). No sprite is needed — every marker this
 * app draws is a DOM marker or a GeoJSON circle.
 *
 * Layer source-layers follow the Protomaps basemaps tile schema (earth,
 * landcover, landuse, water, waterway, building, transportation, boundary,
 * places, transportation_name).
 */

const FONT = ["Noto Sans Regular"];

export type Scheme = "light" | "dark";

/**
 * Basemap paint palettes. The same PMTiles serve both schemes — only the
 * paint colours differ, so dark mode costs no extra tile hosting.
 */
const PALETTES: Record<Scheme, {
  bg: string;
  landcover: string;
  landuse: string;
  water: string;
  building: string;
  casing: Record<Tier, string>;
  road: Record<Exclude<Tier, "rail">, string>;
  boundaryMinor: string;
  boundaryCountry: string;
  ink: string;
  inkSoft: string;
  inkFaint: string;
  halo: string;
}> = {
  light: {
    bg: "#f2efe9",
    landcover: "#e5edda",
    landuse: "#dfebd3",
    water: "#a9c6da",
    building: "#e0dbd2",
    casing: { minor: "#d8d2c7", mid: "#e3cfa0", major: "#dda752", rail: "#c8c2b6" },
    road: { minor: "#ffffff", mid: "#fce9b8", major: "#f5c269" },
    boundaryMinor: "#ccc4b4",
    boundaryCountry: "#b9af9e",
    ink: "#57534b",
    inkSoft: "#6b665d",
    inkFaint: "#8a857b",
    halo: "#ffffff",
  },
  dark: {
    bg: "#191613",
    landcover: "#20251a",
    landuse: "#242b1d",
    water: "#2c4257",
    building: "#26211a",
    casing: { minor: "#221e18", mid: "#4a3f2b", major: "#6a562c", rail: "#322d26" },
    road: { minor: "#2e2a23", mid: "#55492e", major: "#8a6f33" },
    boundaryMinor: "#453f33",
    boundaryCountry: "#57503f",
    ink: "#c9c1b2",
    inkSoft: "#948c7c",
    inkFaint: "#7d766a",
    halo: "#191613",
  },
};

export function preferredScheme(): Scheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Marker + accuracy-circle colours that read against the basemap. */
export function mapUiColors(scheme: Scheme): { marker: string; accuracyFill: string } {
  return scheme === "dark"
    ? { marker: "#e0574d", accuracyFill: "#2e9c8a" }
    : { marker: "#b3261e", accuracyFill: "#175e54" };
}

export function buildPmtilesStyle(tilesUrl: string, scheme: Scheme = "light"): StyleSpecification {
  const p = PALETTES[scheme];
  return {
    version: 8,
    name: "Find Me basemap",
    glyphs: "/tiles/fonts/{fontstack}/{range}.pbf",
    sources: {
      basemap: { type: "vector", url: tilesUrl },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": p.bg } },

      {
        id: "base-earth",
        type: "fill",
        source: "basemap",
        "source-layer": "earth",
        paint: { "fill-color": p.bg },
      },
      {
        id: "base-landcover",
        type: "fill",
        source: "basemap",
        "source-layer": "landcover",
        paint: { "fill-color": p.landcover, "fill-opacity": 0.85 },
      },
      {
        id: "base-landuse",
        type: "fill",
        source: "basemap",
        "source-layer": "landuse",
        paint: { "fill-color": p.landuse },
      },
      {
        id: "base-water",
        type: "fill",
        source: "basemap",
        "source-layer": "water",
        paint: { "fill-color": p.water },
      },
      {
        id: "base-waterway",
        type: "line",
        source: "basemap",
        "source-layer": "waterway",
        paint: {
          "line-color": p.water,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.4, 14, 1.6, 16, 3],
        },
      },
      {
        id: "base-building",
        type: "fill",
        source: "basemap",
        "source-layer": "building",
        minzoom: 13,
        paint: { "fill-color": p.building },
      },

      roadLayer("base-road-minor-casing", "minor", p.casing.minor, [0, 0, 13, 0.5, 16, 4]),
      roadLayer("base-road-mid-casing", "mid", p.casing.mid, [8, 0.4, 13, 1, 16, 6]),
      roadLayer("base-road-major-casing", "major", p.casing.major, [6, 0.5, 13, 1.3, 16, 7]),
      roadLayer("base-road-rail", "rail", p.casing.rail, [10, 0.5, 14, 1.4, 16, 2.4]),
      roadLayer("base-road-minor", "minor", p.road.minor, [11, 0.5, 13, 1, 16, 3.5]),
      roadLayer("base-road-mid", "mid", p.road.mid, [8, 0.4, 13, 1, 16, 5.5]),
      roadLayer("base-road-major", "major", p.road.major, [6, 0.5, 13, 1.2, 16, 6.5]),

      {
        id: "base-boundary-minor",
        type: "line",
        source: "basemap",
        "source-layer": "boundary",
        filter: ["!=", ["get", "kind"], "country"],
        paint: { "line-color": p.boundaryMinor, "line-width": 0.6 },
      },
      {
        id: "base-boundary-country",
        type: "line",
        source: "basemap",
        "source-layer": "boundary",
        filter: ["==", ["get", "kind"], "country"],
        paint: { "line-color": p.boundaryCountry, "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 10, 1.4] },
      },

      placeLayer("base-place-continent", "continent", 13, p.inkFaint, p.halo, true),
      placeLayer("base-place-country", "country", 12, p.inkSoft, p.halo, false),
      placeLayer("base-place-state", "state", 11, p.inkSoft, p.halo, false),
      placeLayer("base-place-city", "city", 12.5, p.ink, p.halo, false),
      placeLayer("base-place-town", "town", 11.5, p.ink, p.halo, false),
      placeLayer("base-place-small", "village/locality/neighbourhood", 10.5, p.inkSoft, p.halo, false),

      {
        id: "base-road-name",
        type: "symbol",
        source: "basemap",
        "source-layer": "transportation_name",
        minzoom: 14,
        layout: {
          "symbol-placement": "line",
          "text-field": ["get", "name"],
          "text-font": FONT,
          "text-size": 10.5,
        },
        paint: { "text-color": p.inkSoft, "text-halo-color": p.halo, "text-halo-width": 1.2 },
      },
    ],
  };
}

type Tier = "minor" | "mid" | "major" | "rail";

const TIER_FILTERS: Record<Tier, unknown> = {
  minor: ["==", ["get", "kind"], "minor_road"],
  mid: [
    "any",
    ["==", ["get", "kinddetail"], "primary"],
    ["==", ["get", "kinddetail"], "secondary"],
    ["==", ["get", "kinddetail"], "tertiary"],
  ],
  major: [
    "any",
    ["==", ["get", "kinddetail"], "motorway"],
    ["==", ["get", "kinddetail"], "trunk"],
  ],
  rail: ["==", ["get", "kind"], "rail"],
};

function roadLayer(id: string, tier: Tier, color: string, stops: number[]): LayerSpecification {
  const dash = tier === "rail"
    ? ["interpolate", ["linear"], ["zoom"], 13, ["literal", [2, 2]], 16, ["literal", [3, 2]]]
    : undefined;
  return {
    id,
    type: "line",
    source: "basemap",
    "source-layer": "transportation",
    filter: TIER_FILTERS[tier],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": color,
      "line-width": ["interpolate", ["linear"], ["zoom"], ...stops],
      ...(dash ? { "line-dasharray": dash } : {}),
    },
  } as unknown as LayerSpecification;
}

function placeLayer(
  id: string,
  kinds: string,
  size: number,
  color: string,
  halo: string,
  uppercase: boolean,
): LayerSpecification {
  return {
    id,
    type: "symbol",
    source: "basemap",
    "source-layer": "places",
    // Protomaps place features carry min_zoom; only draw them once relevant.
    filter: ["all", ["<=", ["get", "min_zoom"], ["zoom"]], ["in", ["get", "kind"], ["literal", kinds.split("/")]]],
    layout: {
      "text-field": ["get", "name"],
      "text-font": FONT,
      "text-size": size,
      ...(uppercase ? { "text-transform": "uppercase", "text-letter-spacing": 0.12 } : {}),
    },
    paint: { "text-color": color, "text-halo-color": halo, "text-halo-width": 1.3 },
  } as unknown as LayerSpecification;
}
