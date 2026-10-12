// Loads demo data for two regions, one user per role, and trips from the timetables around "now":
//   Sri Lanka: 3 demo routes (Colombo buses and the Main Line to Kandy), 4 vehicles and a demo timetable.
//   Dubai: real RTA routes, stops, fare zones, running times and timetables (Metro Red and Green lines, the tram and
//          four bus routes) from db/data/dubai-rta.json, which scripts/import-dubai-gtfs.js builds from RTA's GTFS feed.
//   npm run seed          adds any region that is missing and refreshes the trips
//   npm run seed:reset    wipes every table first
import { readFileSync } from 'node:fs';

import bcrypt from 'bcryptjs';

import { closePool, insertMany, isMssql, query, withTransaction } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { fareBetween } from '../src/config/regions.js';
import { clearStopsCache, getRouteStops } from '../src/modules/routes/stops.js';
import { fillTimetable } from '../src/modules/routes/timetable.js';
import { stopOffsets } from '../src/utils/eta.js';

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

const DUBAI = JSON.parse(readFileSync(new URL('../db/data/dubai-rta.json', import.meta.url), 'utf8'));

export async function seed({ reset = false } = {}) {
  if (env.isProd && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Refusing to seed demo accounts in production. Set ALLOW_DEMO_SEED=true if this is a demo deployment.');
  }
  if (reset) await wipe();

  const regionMissing = async (region) => (await query('SELECT COUNT(*) AS n FROM routes WHERE region = ?', [region]))[0].n === 0;
  if (await regionMissing('SRI_LANKA')) await seedSriLanka();
  if (await regionMissing('DUBAI')) await seedDubai();
  clearStopsCache();
  await addDemoTimetables();
  await seedTrips();
}

// children before parents, so foreign keys never block a delete
const TABLES = ['alert_recipients', 'delay_alerts', 'ticket_scans', 'payments', 'tickets', 'occupancy_log', 'location_log', 'trips', 'reports',
  'staff', 'authority_officers', 'refresh_tokens', 'password_resets', 'users', 'vehicles', 'route_departures', 'route_stops', 'stops', 'routes'];

/** Empties every table and restarts the ids at 1. */
async function wipe() {
  if (!isMssql) {
    // one connection, so FOREIGN_KEY_CHECKS = 0 applies to the TRUNCATEs
    await withTransaction(async (conn) => {
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of TABLES) await conn.query(`TRUNCATE TABLE ${t}`);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    });
    return;
  }
  // SQL Server cannot TRUNCATE a table a foreign key points at
  for (const t of TABLES) {
    await query(`DELETE FROM ${t}`);
    // RESEED 0 makes the next id 1, but only on a table that has had rows (on a fresh one the next id would be 0)
    await query(
      `IF EXISTS (SELECT 1 FROM sys.identity_columns WHERE object_id = OBJECT_ID('${t}') AND last_value IS NOT NULL) DBCC CHECKIDENT ('${t}', RESEED, 0) WITH NO_INFOMSGS`,
    );
  }
}

/** Inserts rows that carry their own ids. SQL Server only allows that with IDENTITY_INSERT on, in the same session. */
async function insertWithIds(table, columns, rows) {
  await withTransaction(async (conn) => {
    if (isMssql) await conn.query(`SET IDENTITY_INSERT ${table} ON`);
    await insertMany(table, columns, rows, conn);
    if (isMssql) await conn.query(`SET IDENTITY_INSERT ${table} OFF`);
  });
}

async function seedSriLanka() {
  await insertWithIds('stops', ['stop_id', 'name', 'latitude', 'longitude'], STOPS);
  await insertWithIds('routes', ['route_id', 'route_no', 'name', 'mode', 'origin', 'destination'], ROUTES);
  await insertMany(
    'route_stops',
    ['route_id', 'stop_id', 'stop_sequence', 'fare_from_origin'],
    Object.entries(ROUTE_STOPS).flatMap(([routeId, list]) => list.map(([stopId, fare], i) => [Number(routeId), stopId, i + 1, fare])),
  );
  await insertWithIds('vehicles', ['vehicle_id', 'reg_no', 'type', 'capacity', 'route_id'], VEHICLES);

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

/** Dubai RTA data: real stops, stop order, fare zones, running times and departure times. Vehicles are named per route. */
async function seedDubai() {
  const stopIds = [];
  for (const s of DUBAI.stops) {
    stopIds.push((await query('INSERT INTO stops (name, latitude, longitude, fare_zone) VALUES (?, ?, ?, ?)', [s.name, s.lat, s.lng, s.zone])).insertId);
  }
  for (const r of DUBAI.routes) {
    const routeId = (await query('INSERT INTO routes (region, route_no, name, mode, origin, destination) VALUES (?, ?, ?, ?, ?, ?)', [
      'DUBAI', r.routeNo, r.name, r.mode, r.origin, r.destination,
    ])).insertId;
    const stops = r.stops.map(([i, seconds], k) => ({ stopId: stopIds[i], stopSequence: k + 1, fareZone: DUBAI.stops[i].zone, seconds }));
    // fare_from_origin is what the app lists next to each stop: the zone fare from the first stop
    await insertMany(
      'route_stops',
      ['route_id', 'stop_id', 'stop_sequence', 'fare_from_origin', 'seconds_from_origin'],
      stops.map((s, k) => [routeId, s.stopId, s.stopSequence, k === 0 ? 0 : fareBetween('DUBAI', stops, stops[0], s), s.seconds]),
    );
    await insertMany(
      'route_departures',
      ['route_id', 'service_days', 'depart_minute'],
      r.departures.flatMap((d) => d.times.map((minute) => [routeId, d.days, minute])),
    );
    await insertMany(
      'vehicles',
      ['reg_no', 'type', 'capacity', 'route_id'],
      Array.from({ length: r.fleet }, (_, n) => [`${r.regPrefix}-${String(n + 1).padStart(2, '0')}`, r.mode, r.capacity, routeId]),
    );
  }
}

/**
 * Routes with no timetable (the Sri Lanka demo routes, or routes added in the admin panel) get a demo one: each vehicle
 * leaves the first stop every 1 to 3 hours, all day, every day, the vehicles 15 minutes apart.
 */
async function addDemoTimetables() {
  const routes = await query(
    'SELECT route_id, mode FROM routes r WHERE is_active = 1 AND NOT EXISTS (SELECT 1 FROM route_departures d WHERE d.route_id = r.route_id)',
  );
  const vehicles = await query('SELECT vehicle_id, route_id FROM vehicles WHERE is_active = 1 ORDER BY vehicle_id');
  const rows = new Map(); // two vehicles can land on the same minute; the timetable holds each departure once
  for (const r of routes) {
    const stops = await getRouteStops(r.route_id);
    if (stops.length < 2) continue;
    const minutes = Math.ceil(stopOffsets(stops, r.mode).at(-1) / 60);
    const gap = Math.max(Math.ceil((minutes + 10) / 30) * 30, 60); // a vehicle starts its next trip after finishing this one
    for (const v of vehicles.filter((x) => x.route_id === r.route_id)) {
      for (let m = (vehicles.indexOf(v) * 15) % gap; m < 1440; m += gap) rows.set(`${r.route_id}:${m}`, [r.route_id, '1111111', m]);
    }
  }
  await insertMany('route_departures', ['route_id', 'service_days', 'depart_minute'], [...rows.values()]);
}

/** Replaces trips nobody depends on with the timetable from 3 hours ago to 12 hours ahead, so arrivals are never empty. */
async function seedTrips() {
  await query(
    `DELETE FROM trips WHERE NOT EXISTS (SELECT 1 FROM tickets t WHERE t.trip_id = trips.trip_id)
                         AND NOT EXISTS (SELECT 1 FROM delay_alerts a WHERE a.trip_id = trips.trip_id)`,
  );
  const now = Date.now();
  return fillTimetable(new Date(now - 3 * 3600000), new Date(now + 12 * 3600000), now);
}

if (process.argv[1]?.endsWith('seed.js')) {
  await seed({ reset: process.argv.includes('--reset') });
  console.log('Seed complete (Sri Lanka and Dubai). Demo accounts: passenger@ridetrack.test, staff@ridetrack.test, officer@ridetrack.test');
  await closePool();
}
