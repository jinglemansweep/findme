import { useEffect, useRef } from "react";
import {
  Map,
  Marker,
  type GeoJSONSource,
  type Map as MaplibreMap,
  type Marker as MarkerType,
} from "maplibre-gl";
import type { AppConfig } from "../types";
import { accuracyCircle } from "../lib/geo";
import { buildPmtilesStyle } from "../mapStyle";

/**
 * One imperative MapLibre instance held in a ref and driven from effects —
 * no React wrapper (PLAN.md §14). The marker is a DOM marker; the accuracy
 * radius is a GeoJSON fill layer (§4: render the radius, not a bare dot).
 */

export interface MapViewProps {
  config: AppConfig;
  position?: { lat: number; lng: number; accuracy?: number | null } | null;
  /** Recenter on position changes until the user pans. */
  follow?: boolean;
  /** Increment to force a recenter (the "recenter" button). */
  recenterToken?: number;
  /** Zoom to fit the accuracy circle on the first fix only. */
  fitAccuracyOnFirstFix?: boolean;
  onMapClick?: (coords: { lat: number; lng: number }) => void;
  showAccuracy?: boolean;
  dimmed?: boolean;
  /** Ref to the floating info panel overlaying this map, if any. The camera
   *  keeps centred markers clear of it (its real size, tracked live). */
  overlayRef?: React.RefObject<HTMLDivElement | null>;
}

const DEFAULT_CENTER: [number, number] = [-2.6, 54.4]; // UK-ish
const DEFAULT_ZOOM = 5;

/**
 * Persistent camera padding derived from the floating panel's actual rect:
 * when the panel sits beside open map (desktop) markers centre in the free
 * left area; when it spans the width (phones) they centre above it. All
 * camera operations (easeTo, project, fitBounds) respect this.
 */
function paddingForOverlay(overlay: HTMLElement | null): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  const rect = overlay?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) {
    const freeLeft = window.innerWidth - rect.width - 24;
    if (freeLeft > 220) {
      return { top: 70, bottom: 60, left: 20, right: window.innerWidth - rect.left + 24 };
    }
    return { top: 70, bottom: rect.height + 28, left: 16, right: 16 };
  }
  return { top: 70, bottom: 90, left: 16, right: 16 };
}

export function MapView(props: MapViewProps) {
  const { config, position, follow = false, recenterToken = 0, fitAccuracyOnFirstFix = false } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const markerRef = useRef<MarkerType | null>(null);
  const userPannedRef = useRef(false);
  const hadFixRef = useRef(false);
  const clickRef = useRef(props.onMapClick);
  clickRef.current = props.onMapClick;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const style =
      config.basemap.kind === "pmtiles"
        ? buildPmtilesStyle(config.basemap.tilesUrl)
        : config.basemap.url;

    const map = new Map({
      container: containerRef.current,
      style,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      ...(config.basemap.kind === "pmtiles" && config.mapBounds
        ? { maxBounds: config.mapBounds as [[number, number], [number, number]] }
        : {}),
      // No map attribution control: the OSM attribution lives in the page
      // footer on every shell, keeping the map itself clear.
      attributionControl: false,
    });
    mapRef.current = map;

    // dragstart only fires on user interaction, not programmatic moves.
    map.on("dragstart", () => {
      userPannedRef.current = true;
    });
    map.on("click", (e) => clickRef.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng }));

    map.on("load", () => {
      if (!map.getStyle()) return;
      updatePadding();
      map.addSource("accuracy", { type: "geojson", data: emptyFeatureCollection() });
      map.addLayer({
        id: "accuracy-fill",
        type: "fill",
        source: "accuracy",
        paint: { "fill-color": "#175e54", "fill-opacity": 0.14 },
      });
    });

    const updatePadding = () => map.setPadding(paddingForOverlay(props.overlayRef?.current ?? null));
    const onResize = () => updatePadding();
    window.addEventListener("resize", onResize);

    // The panel's height changes with its content (form ↔ success panel,
    // expanding fields) — keep the camera clear of its live footprint.
    const observer = props.overlayRef?.current
      ? new ResizeObserver(() => updatePadding())
      : null;
    if (observer && props.overlayRef?.current) observer.observe(props.overlayRef.current);

    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      userPannedRef.current = false;
      hadFixRef.current = false;
    };
    // The map instance is created once; config is captured deliberately.
  }, []);

  // Marker + accuracy circle + follow behaviour.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !position) return;

    const lngLat: [number, number] = [position.lng, position.lat];
    const apply = () => {
      if (!markerRef.current) {
        markerRef.current = new Marker({ color: "#b3261e" }).setLngLat(lngLat).addTo(map);
      } else {
        markerRef.current.setLngLat(lngLat);
      }

      const source = map.getSource("accuracy") as GeoJSONSource | undefined;
      if (source) {
        const circle =
          props.showAccuracy !== false && position.accuracy
            ? accuracyCircle(position.lat, position.lng, position.accuracy)
            : null;
        source.setData(circle ?? emptyFeatureCollection());
      }

      const shouldFollow = follow && !userPannedRef.current;
      const shouldFit = fitAccuracyOnFirstFix && !hadFixRef.current;
      hadFixRef.current = true;
      if (shouldFit && position.accuracy && position.accuracy > 20) {
        const circle = accuracyCircle(position.lat, position.lng, position.accuracy);
        if (circle) {
          const [w, s] = circle.geometry.coordinates[0][0];
          const [e, n] = circle.geometry.coordinates[0][36];
          map.fitBounds(
            [
              [w, s],
              [e, n],
            ],
            { padding: paddingForOverlay(props.overlayRef?.current ?? null), maxZoom: 16, duration: 600 },
          );
          return;
        }
      }
      if (shouldFollow || shouldFit) {
        map.easeTo({ center: lngLat, zoom: Math.max(map.getZoom(), shouldFit ? 14 : map.getZoom()), duration: 500 });
      }
    };

    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [position, follow, fitAccuracyOnFirstFix, props.showAccuracy]);

  // Forced recenter (button).
  useEffect(() => {
    if (!recenterToken || !position || !mapRef.current) return;
    userPannedRef.current = false;
    mapRef.current.easeTo({ center: [position.lng, position.lat], duration: 500 });
  }, [recenterToken, position]);

  return (
    <div
      className={`map-wrap${props.dimmed ? " dimmed" : ""}${props.onMapClick ? " clickable" : ""}`}
      ref={containerRef}
      role="application"
      aria-label="Map showing the shared location"
    />
  );
}

function emptyFeatureCollection(): GeoJSON.FeatureCollection<GeoJSON.Geometry> {
  return { type: "FeatureCollection", features: [] };
}
