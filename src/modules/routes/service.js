import { isDuplicateKey, isMissingReference, limit as limitRows, query } from '../../config/db.js';
import { env } from '../../config/env.js';
import { regionInfo } from '../../config/regions.js';
import { badRequest, conflict, notFound } from '../../utils/errors.js';
import { liveEta, scheduledEta, stopOffsets } from '../../utils/eta.js';
import { boundingBox, haversineMeters } from '../../utils/geo.js';
import { emitOpsUpdate } from '../../realtime/index.js';
import { getLivePosition } from '../vehicles/positions.js';
import { clearStopsCache, getRouteStops } from './stops.js';

/** A route as the app sees it. Times are shown in its region's time zone and fares in its currency. */
export const toRoute = (r) => {
  const region = regionInfo(r.region);
  return {
    routeId: r.route_id,
    routeNo: r.route_no,
    name: r.name,
    mode: r.mode,
    origin: r.origin,
    destination: r.destination,
    region: r.region,
    timeZone: region.timeZone,
    currency: region.currency,
    zoneFares: region.zoneFares,
  };
};

export async function searchRoutes({ q, mode, region, page, limit }) {
  const where = ['is_active = 1'];
  const params = [];
  if (mode) (where.push('mode = ?'), params.push(mode));
  if (region) (where.push('region = ?'), params.push(region));
  if (q) {
    // '!' escapes LIKE wildcards the same way in MySQL and SQL Server (a backslash does not)
    const like = `%${q.replace(/[%_![]/g, (c) => `!${c}`)}%`;
    where.push("(route_no LIKE ? ESCAPE '!' OR name LIKE ? ESCAPE '!' OR origin LIKE ? ESCAPE '!' OR destination LIKE ? ESCAPE '!')");
    params.push(like, like, like, like);
  }
  const rows = await query(
    `SELECT * FROM routes WHERE ${where.join(' AND ')} ORDER BY region DESC, mode, route_no, route_id ${limitRows(limit, (page - 1) * limit)}`,
    params,
  );
  return rows.map(toRoute);
}

export async function getRoute(routeId) {
  const [row] = await query('SELECT * FROM routes WHERE route_id = ? AND is_active = 1', [routeId]);
  if (!row) throw notFound('Route not found.');
  return { ...toRoute(row), stops: await getRouteStops(routeId) };
}

export async function nearbyStops({ lat, lng, radius }) {
  const box = boundingBox(lat, lng, radius);
  // one row per (stop, route), grouped here: GROUP_CONCAT and STRING_AGG differ per database
  const rows = await query(
    `SELECT DISTINCT s.stop_id, s.name, s.latitude, s.longitude, rs.route_id
       FROM stops s JOIN route_stops rs ON rs.stop_id = s.stop_id JOIN routes r ON r.route_id = rs.route_id AND r.is_active = 1
      WHERE s.latitude BETWEEN ? AND ? AND s.longitude BETWEEN ? AND ?
      ORDER BY s.stop_id, rs.route_id`,
    [box.minLat, box.maxLat, box.minLng, box.maxLng],
  );
  const byStop = new Map();
  for (const r of rows) {
    const stop = byStop.get(r.stop_id);
    if (stop) stop.routeIds.push(r.route_id);
    else byStop.set(r.stop_id, { ...r, routeIds: [r.route_id] });
  }
  return [...byStop.values()]
    .map((r) => ({
      stopId: r.stop_id,
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      distanceMeters: Math.round(haversineMeters(lat, lng, r.latitude, r.longitude)),
      routeIds: r.routeIds,
    }))
    .filter((s) => s.distanceMeters <= radius)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, 20);
}

/** Upcoming trips at a stop, soonest first. Live ETA when the vehicle is reporting, timetable otherwise. */
export async function arrivals(routeId, stopId) {
  const [route] = await query('SELECT mode FROM routes WHERE route_id = ? AND is_active = 1', [routeId]);
  if (!route) throw notFound('Route not found.');
  const stops = await getRouteStops(routeId);
  const idx = stops.findIndex((s) => s.stopId === stopId);
  if (idx < 0) throw notFound('That stop is not on this route.');
  const offsets = stopOffsets(stops, route.mode);

  const trips = await query(
    `SELECT trip_id, vehicle_id, start_time, status FROM trips
      WHERE route_id = ? AND status IN ('SCHEDULED','ONGOING','DELAYED')
        AND start_time BETWEEN ? AND ?
      ORDER BY start_time`,
    [routeId, new Date(Date.now() - 6 * 3600000), new Date(Date.now() + 12 * 3600000)],
  );

  const now = new Date();
  const out = [];
  for (const t of trips) {
    const live = t.status !== 'SCHEDULED' ? await getLivePosition(t.vehicle_id, env.livePositionMaxAgeMs) : null;
    let eta = live ? liveEta(live, stops, offsets, idx, route.mode, now) : null;
    let scheduled = false;
    if (!eta) {
      // no live position (or the vehicle has already passed this stop): fall back to the timetable
      if (live) continue; // live and passed this stop: not an upcoming arrival
      eta = scheduledEta(new Date(t.start_time), offsets, idx);
      scheduled = true;
    }
    if (eta.getTime() < now.getTime() - 60_000) continue;
    out.push({ tripId: t.trip_id, routeId, vehicleId: t.vehicle_id, eta: eta.toISOString(), scheduled, status: t.status });
  }
  return out.sort((a, b) => a.eta.localeCompare(b.eta)).slice(0, 10);
}

// ---------- authority management ----------

export async function createRoute({ region = 'SRI_LANKA', routeNo, name, mode, origin, destination }) {
  try {
    const r = await query('INSERT INTO routes (region, route_no, name, mode, origin, destination) VALUES (?, ?, ?, ?, ?, ?)', [
      region, routeNo, name, mode, origin, destination,
    ]);
    return getRoute(r.insertId);
  } catch (e) {
    if (isDuplicateKey(e)) throw conflict('A route with this number, mode and direction already exists.', 'ROUTE_EXISTS');
    throw e;
  }
}

export async function updateRoute(routeId, input) {
  const cols = { routeNo: 'route_no', name: 'name', origin: 'origin', destination: 'destination', isActive: 'is_active' };
  const sets = Object.keys(input).filter((k) => cols[k]);
  if (sets.length) {
    await query(`UPDATE routes SET ${sets.map((k) => `${cols[k]} = ?`).join(', ')} WHERE route_id = ?`, [...sets.map((k) => input[k]), routeId]);
  }
  clearStopsCache();
  return getRoute(routeId);
}

/** Adds a stop to a route at a sequence position. Pass an existing `stopId`, or `name`+`latitude`+`longitude` to create one. */
export async function addRouteStop(routeId, { stopId, name, latitude, longitude, stopSequence, fareFromOrigin }) {
  await getRoute(routeId);
  let id = stopId;
  if (!id) {
    if (!name || latitude == null || longitude == null) throw badRequest('Provide a stopId, or name, latitude and longitude for a new stop.');
    id = (await query('INSERT INTO stops (name, latitude, longitude) VALUES (?, ?, ?)', [name, latitude, longitude])).insertId;
  }
  try {
    await query('INSERT INTO route_stops (route_id, stop_id, stop_sequence, fare_from_origin) VALUES (?, ?, ?, ?)', [
      routeId, id, stopSequence, fareFromOrigin,
    ]);
  } catch (e) {
    if (isDuplicateKey(e)) throw conflict('That stop or position is already used on this route.', 'ROUTE_STOP_EXISTS');
    if (isMissingReference(e)) throw notFound('Stop not found.');
    throw e;
  }
  clearStopsCache();
  return getRoute(routeId);
}

const toTrip = (t) => ({
  tripId: t.trip_id,
  routeId: t.route_id,
  vehicleId: t.vehicle_id,
  startTime: new Date(t.start_time).toISOString(),
  endTime: t.end_time ? new Date(t.end_time).toISOString() : null,
  status: t.status,
});

export async function createTrip({ routeId, vehicleId, startTime, endTime }) {
  const [vehicle] = await query('SELECT route_id FROM vehicles WHERE vehicle_id = ? AND is_active = 1', [vehicleId]);
  if (!vehicle) throw notFound('Vehicle not found.');
  if (vehicle.route_id !== routeId) throw badRequest('That vehicle is not assigned to this route.');
  const r = await query('INSERT INTO trips (route_id, vehicle_id, start_time, end_time) VALUES (?, ?, ?, ?)', [
    routeId, vehicleId, new Date(startTime), endTime ? new Date(endTime) : null,
  ]);
  const [row] = await query('SELECT * FROM trips WHERE trip_id = ?', [r.insertId]);
  emitOpsUpdate('trip');
  return toTrip(row);
}

export async function updateTrip(tripId, { status, startTime, endTime }) {
  const sets = [];
  const params = [];
  if (status) (sets.push('status = ?'), params.push(status));
  if (startTime) (sets.push('start_time = ?'), params.push(new Date(startTime)));
  if (endTime) (sets.push('end_time = ?'), params.push(new Date(endTime)));
  if (!sets.length) throw badRequest('Nothing to update.');
  const r = await query(`UPDATE trips SET ${sets.join(', ')} WHERE trip_id = ?`, [...params, tripId]);
  if (!r.affectedRows) throw notFound('Trip not found.');
  const [row] = await query('SELECT * FROM trips WHERE trip_id = ?', [tripId]);
  emitOpsUpdate('trip');
  return toTrip(row);
}
