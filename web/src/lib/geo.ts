/** Great-circle distance in metres (watch-position throttling, §4). */
export function distanceMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * A circle as a GeoJSON Polygon — the viewer renders the GPS accuracy radius,
 * never a bare dot (§4).
 */
export function accuracyCircle(lat: number, lng: number, radiusMetres: number): GeoJSON.Feature<GeoJSON.Polygon> | null {
  if (!Number.isFinite(radiusMetres) || radiusMetres <= 0) return null;
  const coords: [number, number][] = [];
  const steps = 72;
  for (let i = 0; i <= steps; i++) {
    const bearing = (i / steps) * 2 * Math.PI;
    coords.push(destination(lat, lng, bearing, radiusMetres));
  }
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [coords] },
  };
}

function destination(lat: number, lng: number, bearing: number, distance: number): [number, number] {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const lat1 = toRad(lat);
  const lng1 = toRad(lng);
  const dr = distance / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(bearing));
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(dr) * Math.cos(lat1),
      Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2),
    );
  return [toDeg(lng2), toDeg(lat2)];
}
