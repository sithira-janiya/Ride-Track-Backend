import { query } from '../../config/db.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { cumulativeMeters, liveEta, nextStopIndex } from '../../utils/eta.js';
import { emitOpsUpdate, emitToRoute } from '../../realtime/index.js';
import { getRouteStops } from '../routes/stops.js';
import { getLatest, setLatest } from './positions.js';

async function getVehicle(vehicleId) {
  const [v] = await query(
    'SELECT v.*, r.mode FROM vehicles v JOIN routes r ON r.route_id = v.route_id WHERE v.vehicle_id = ? AND v.is_active = TRUE',
    [vehicleId],
  );
  if (!v) throw notFound('Vehicle not found.');
  return v;
}

/** ETA at the next stop the vehicle will reach (what passengers see on the map chip). */
async function etaToNextStop(routeId, mode, pos, now = new Date()) {
  const stops = await getRouteStops(routeId);
  if (stops.length < 2) return null;
  const next = nextStopIndex(pos, stops);
  return liveEta(pos, stops, cumulativeMeters(stops), next, mode, now);
}

async function latestOccupancy(vehicleId) {
  const [row] = await query('SELECT passenger_count FROM occupancy_log WHERE vehicle_id = ? ORDER BY occ_id DESC LIMIT 1', [vehicleId]);
  return row?.passenger_count ?? null;
}

/** GPS ingest: store, cache, and broadcast to everyone watching the vehicle's route (NFR2: within 5 s). */
export async function ingestLocation(vehicleId, { lat, lng, recordedAt }) {
  const v = await getVehicle(vehicleId);
  const when = recordedAt ? new Date(recordedAt) : new Date();
  // a device clock far in the future would stick as "latest" forever; reject it
  if (when.getTime() > Date.now() + 60_000) throw badRequest('recordedAt is in the future.');
  const eta = await etaToNextStop(v.route_id, v.mode, { lat, lng });
  await query('INSERT INTO location_log (vehicle_id, latitude, longitude, eta, recorded_at) VALUES (?, ?, ?, ?, ?)', [vehicleId, lat, lng, eta, when]);
  setLatest(vehicleId, { lat, lng, eta, recordedAt: when });
  emitToRoute(v.route_id, 'vehicle:location', {
    vehicleId,
    lat,
    lng,
    eta: eta ? eta.toISOString() : null,
    recordedAt: when.toISOString(),
  });
  emitOpsUpdate('vehicle');
}

export async function setOccupancy(vehicleId, passengerCount) {
  const v = await getVehicle(vehicleId);
  if (passengerCount > v.capacity) throw badRequest(`This vehicle holds at most ${v.capacity} passengers.`);
  await query('INSERT INTO occupancy_log (vehicle_id, passenger_count) VALUES (?, ?)', [vehicleId, passengerCount]);
  const payload = { vehicleId, passengerCount, capacity: v.capacity };
  emitToRoute(v.route_id, 'vehicle:occupancy', payload);
  emitOpsUpdate('occupancy');
  return payload;
}

/** Vehicles on a route that have reported at least one position. */
export async function getRouteVehicles(routeId) {
  const vehicles = await query(
    'SELECT v.*, r.mode FROM vehicles v JOIN routes r ON r.route_id = v.route_id WHERE v.route_id = ? AND v.is_active = TRUE ORDER BY v.vehicle_id',
    [routeId],
  );
  return (await Promise.all(vehicles.map((v) => describe(v)))).filter(Boolean);
}

/** One vehicle as the app shows it: position, ETA and occupancy. Null when it has never reported. */
export async function describe(v) {
  const pos = await getLatest(v.vehicle_id);
  if (!pos) return null;
  const eta = await etaToNextStop(v.route_id, v.mode, pos);
  return {
    vehicleId: v.vehicle_id,
    regNo: v.reg_no,
    lat: pos.lat,
    lng: pos.lng,
    eta: eta ? eta.toISOString() : null,
    recordedAt: pos.recordedAt.toISOString(),
    passengerCount: (await latestOccupancy(v.vehicle_id)) ?? undefined,
    capacity: v.capacity,
  };
}
