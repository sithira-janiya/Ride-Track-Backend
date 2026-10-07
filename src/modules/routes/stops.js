import { query } from '../../config/db.js';

const CACHE_MS = 60_000;
const cache = new Map(); // routeId -> { at, stops }

/** Ordered stops of a route (with fares). Cached briefly because ETA code asks for it on every location ping. */
export async function getRouteStops(routeId) {
  const hit = cache.get(routeId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.stops;
  const rows = await query(
    `SELECT s.stop_id, s.name, s.latitude, s.longitude, rs.stop_sequence, rs.fare_from_origin
       FROM route_stops rs JOIN stops s ON s.stop_id = rs.stop_id
      WHERE rs.route_id = ? ORDER BY rs.stop_sequence`,
    [routeId],
  );
  const stops = rows.map((r) => ({
    stopId: r.stop_id,
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    stopSequence: r.stop_sequence,
    fareFromOrigin: r.fare_from_origin,
  }));
  cache.set(routeId, { at: Date.now(), stops });
  return stops;
}

export const clearStopsCache = () => cache.clear();
