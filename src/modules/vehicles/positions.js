import { query } from '../../config/db.js';

// Latest known position per vehicle, kept in memory so reads (arrivals, dashboard) do not hit the DB on every request.
const latest = new Map(); // vehicleId -> { lat, lng, eta, recordedAt: Date }
let loaded = false;

export function setLatest(vehicleId, pos) {
  latest.set(vehicleId, pos);
}

/** Loads the newest row per vehicle from `location_log` once, so a restart does not lose live positions. */
export async function loadLatestPositions() {
  const rows = await query(
    `SELECT l.vehicle_id, l.latitude, l.longitude, l.eta, l.recorded_at
       FROM location_log l
       JOIN (SELECT vehicle_id, MAX(log_id) AS id FROM location_log GROUP BY vehicle_id) m ON m.id = l.log_id`,
  );
  for (const r of rows) {
    latest.set(r.vehicle_id, { lat: r.latitude, lng: r.longitude, eta: r.eta, recordedAt: new Date(r.recorded_at) });
  }
  loaded = true;
}

export async function getLatest(vehicleId) {
  if (!loaded) await loadLatestPositions();
  return latest.get(vehicleId) ?? null;
}

/** Position only if recent enough to call "live". */
export async function getLivePosition(vehicleId, maxAgeMs, now = Date.now()) {
  const pos = await getLatest(vehicleId);
  return pos && now - pos.recordedAt.getTime() <= maxAgeMs ? pos : null;
}

export function resetPositionsCache() {
  latest.clear();
  loaded = false;
}
