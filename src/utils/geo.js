const EARTH_M = 6371000;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineMeters(aLat, aLng, bLat, bLng) {
  const h =
    Math.sin(rad(bLat - aLat) / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return EARTH_M * 2 * Math.asin(Math.sqrt(h));
}

/** Lat/lng box around a point, used to narrow a SQL query before the exact distance check. */
export function boundingBox(lat, lng, radiusM) {
  const dLat = (radiusM / EARTH_M) * (180 / Math.PI);
  const dLng = dLat / Math.max(Math.cos(rad(lat)), 0.01);
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}
