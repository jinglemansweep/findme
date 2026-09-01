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

const INK = "#57534b";
const HALO = "#ffffff";

export function buildPmtilesStyle(tilesUrl: string): StyleSpecification {
  return {
    version: 8,
    name: "Find Me basemap",
    glyphs: "/tiles/fonts/{fontstack}/{range}.pbf",
    sources: {
      basemap: { type: "vector", url: tilesUrl },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#f2efe9" } },

      {
        id: "base-earth",
        type: "fill",
        source: "basemap",
        "source-layer": "earth",
        paint: { "fill-color": "#f2efe9" },
      },
      {
        id: "base-landcover",
        type: "fill",
        source: "basemap",
        "source-layer": "landcover",
        paint: { "fill-color": "#e5edda", "fill-opacity": 0.85 },
      },
      {
        id: "base-landuse",
        type: "fill",
        source: "basemap",
        "source-layer": "landuse",
        paint: { "fill-color": "#dfebd3" },
      },
      {
        id: "base-water",
        type: "fill",
        source: "basemap",
        "source-layer": "water",
        paint: { "fill-color": "#a9c6da" },
      },
      {
        id: "base-waterway",
        type: "line",
        source: "basemap",
        "source-layer": "waterway",
        paint: {
          "line-color": "#a9c6da",
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.4, 14, 1.6, 16, 3],
        },
      },
      {
        id: "base-building",
        type: "fill",
        source: "basemap",
        "source-layer": "building",
        minzoom: 13,
        paint: { "fill-color": "#e0dbd2" },
      },

      roadLayer("base-road-minor-casing", "minor", "#d8d2c7", [0, 0, 13, 0.5, 16, 4]),
      roadLayer("base-road-mid-casing", "mid", "#e3cfa0", [8, 0.4, 13, 1, 16, 6]),
      roadLayer("base-road-major-casing", "major", "#dda752", [6, 0.5, 13, 1.3, 16, 7]),
      roadLayer("base-road-rail", "rail", "#c8c2b6", [10, 0.5, 14, 1.4, 16, 2.4]),
      roadLayer("base-road-minor", "minor", "#ffffff", [11, 0.5, 13, 1, 16, 3.5]),
      roadLayer("base-road-mid", "mid", "#fce9b8", [8, 0.4, 13, 1, 16, 5.5]),
      roadLayer("base-road-major", "major", "#f5c269", [6, 0.5, 13, 1.2, 16, 6.5]),

      {
        id: "base-boundary-minor",
        type: "line",
        source: "basemap",
        "source-layer": "boundary",
        filter: ["!=", ["get", "kind"], "country"],
        paint: { "line-color": "#ccc4b4", "line-width": 0.6 },
      },
      {
        id: "base-boundary-country",
        type: "line",
        source: "basemap",
        "source-layer": "boundary",
        filter: ["==", ["get", "kind"], "country"],
        paint: { "line-color": "#b9af9e", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 10, 1.4] },
      },

      placeLayer("base-place-continent", "continent", 13, "#8a857b", true),
      placeLayer("base-place-country", "country", 12, "#6b665d", false),
      placeLayer("base-place-state", "state", 11, "#6b665d", false),
      placeLayer("base-place-city", "city", 12.5, INK, false),
      placeLayer("base-place-town", "town", 11.5, INK, false),
      placeLayer("base-place-small", "village/locality/neighbourhood", 10.5, "#6b665d", false),

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
        paint: { "text-color": "#7a756b", "text-halo-color": HALO, "text-halo-width": 1.2 },
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
    paint: { "text-color": color, "text-halo-color": HALO, "text-halo-width": 1.3 },
  } as unknown as LayerSpecification;
}
