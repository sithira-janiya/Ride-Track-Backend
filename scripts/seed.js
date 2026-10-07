// Loads demo data: 3 routes with stops and fares, 4 vehicles, one user per role, and trips around "now".
//   npm run seed          adds the base data if the database is empty and refreshes the trips
//   npm run seed:reset    wipes every table first
import bcrypt from 'bcryptjs';

import { pool, query } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { cumulativeMeters, SPEED_MPS } from '../src/utils/eta.js';

/** Password for all demo accounts. Demo data only: never seed this into a real deployment. */
export const DEMO_PASSWORD = 'Password1!';

const STOPS = [
  [1, 'Colombo Fort', 6.9335, 79.8501],
  [2, 'Maradana', 6.9271, 79.8612],
  [3, 'Borella', 6.9147, 79.8777],
  [4, 'Nugegoda', 6.8649, 79.8997],
  [5, 'Kottawa', 6.8419, 79.9654],
  [6, 'Ragama', 7.0289, 79.9219],
  [7, 'Gampaha', 7.0873, 79.9925],
  [8, 'Kandy', 7.2906, 80.6337],
  [9, 'Kaduwela', 6.9331, 79.9847],
];
const ROUTES = [
  [1, '138', 'Colombo - Kottawa', 'BUS', 'Colombo Fort', 'Kottawa'],
  [2, 'MAIN', 'Main Line - Colombo to Kandy', 'TRAIN', 'Colombo Fort', 'Kandy'],
  [3, '177', 'Colombo - Kaduwela', 'BUS', 'Colombo Fort', 'Kaduwela'],
];
// route -> [stopId, fareFromOrigin] in order
const ROUTE_STOPS = {
  1: [[1, 0], [2, 30], [3, 50], [4, 80], [5, 120]],
  2: [[1, 0], [2, 60], [6, 140], [7, 190], [8, 520]],
  3: [[1, 0], [2, 30], [3, 50], [9, 90]],
};
const VEHICLES = [
  [101, 'NB-1234', 'BUS', 52, 1],
  [102, 'NB-5678', 'BUS', 52, 1],
  [201, 'TR-0042', 'TRAIN', 480, 2],
  [301, 'NB-9001', 'BUS', 52, 3],
];

export async function seed({ reset = false } = {}) {
  if (env.isProd && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Refusing to seed demo accounts in production. Set ALLOW_DEMO_SEED=true if this is a demo deployment.');
  }
  if (reset) {
    await query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['alert_recipients', 'delay_alerts', 'ticket_scans', 'payments', 'tickets', 'occupancy_log', 'location_log', 'trips', 'reports',
      'staff', 'authority_officers', 'refresh_tokens', 'users', 'vehicles', 'route_stops', 'stops', 'routes']) {
      await query(`TRUNCATE TABLE ${t}`);
    }
    await query('SET FOREIGN_KEY_CHECKS = 1');
  }

  const [{ n }] = await query('SELECT COUNT(*) AS n FROM routes');
  if (n === 0) {
    for (const s of STOPS) await query('INSERT INTO stops (stop_id, name, latitude, longitude) VALUES (?, ?, ?, ?)', s);
    for (const r of ROUTES) await query('INSERT INTO routes (route_id, route_no, name, mode, origin, destination) VALUES (?, ?, ?, ?, ?, ?)', r);
    for (const [routeId, list] of Object.entries(ROUTE_STOPS)) {
      for (const [i, [stopId, fare]] of list.entries()) {
        await query('INSERT INTO route_stops (route_id, stop_id, stop_sequence, fare_from_origin) VALUES (?, ?, ?, ?)', [routeId, stopId, i + 1, fare]);
      }
    }
    for (const v of VEHICLES) await query('INSERT INTO vehicles (vehicle_id, reg_no, type, capacity, route_id) VALUES (?, ?, ?, ?, ?)', v);

    const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const users = [
      ['Demo Passenger', 'passenger@ridetrack.test', 'PASSENGER'],
      ['Demo Conductor', 'staff@ridetrack.test', 'STAFF'],
      ['Demo Officer', 'officer@ridetrack.test', 'AUTHORITY'],
    ];
    const ids = [];
    for (const [name, email, role] of users) {
      ids.push((await query('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [name, email, hash, role])).insertId);
    }
    await query("INSERT INTO staff (user_id, employee_no, organisation, staff_type, vehicle_id) VALUES (?, 'ST-001', 'Demo Transport Co.', 'CONDUCTOR', 101)", [ids[1]]);
    await query("INSERT INTO authority_officers (user_id, department, employee_no) VALUES (?, 'Transport Authority', 'AU-001')", [ids[2]]);
  }

  await seedTrips();
}

/** Replaces trips nobody depends on with a fresh timetable around the current time, so arrivals are never empty. */
async function seedTrips() {
  await query(
    `DELETE FROM trips WHERE NOT EXISTS (SELECT 1 FROM tickets t WHERE t.trip_id = trips.trip_id)
                         AND NOT EXISTS (SELECT 1 FROM delay_alerts a WHERE a.trip_id = trips.trip_id)`,
  );
  const stopRows = await query(
    `SELECT rs.route_id, s.latitude, s.longitude FROM route_stops rs JOIN stops s ON s.stop_id = rs.stop_id ORDER BY rs.route_id, rs.stop_sequence`,
  );
  const durations = {};
  for (const routeId of new Set(stopRows.map((r) => r.route_id))) {
    const pts = stopRows.filter((r) => r.route_id === routeId);
    const [route] = await query('SELECT mode FROM routes WHERE route_id = ?', [routeId]);
    const meters = cumulativeMeters(pts.map((p) => ({ latitude: p.latitude, longitude: p.longitude }))).at(-1);
    durations[routeId] = Math.ceil(meters / SPEED_MPS[route.mode] / 60); // minutes
  }

  const now = Date.now();
  const half = 30 * 60000;
  const first = Math.floor((now - 3 * 3600000) / half) * half; // trips from 3 hours ago to 12 hours ahead
  const vehicles = await query('SELECT vehicle_id, route_id FROM vehicles WHERE is_active = TRUE ORDER BY vehicle_id');
  for (const [vi, v] of vehicles.entries()) {
    const minutes = durations[v.route_id];
    const gap = Math.max(Math.ceil((minutes + 10) / 30) * 30, 60) * 60000; // a vehicle starts its next trip after finishing this one
    for (let t = first + vi * 15 * 60000; t < now + 12 * 3600000; t += gap) {
      const end = t + minutes * 60000;
      const status = end <= now ? 'COMPLETED' : t <= now ? 'ONGOING' : 'SCHEDULED';
      await query('INSERT INTO trips (route_id, vehicle_id, start_time, end_time, status) VALUES (?, ?, ?, ?, ?)', [v.route_id, v.vehicle_id, new Date(t), new Date(end), status]);
    }
  }
}

if (process.argv[1]?.endsWith('seed.js')) {
  await seed({ reset: process.argv.includes('--reset') });
  console.log('Seed complete. Demo accounts: passenger@ridetrack.test, staff@ridetrack.test, officer@ridetrack.test');
  await pool.end();
}
