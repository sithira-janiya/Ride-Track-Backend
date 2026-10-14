// Builds db/data/dubai-rta.json from Dubai RTA's GTFS feed: real stops, stop order, fare zones, running times and
// departure timetables for the Dubai Metro, the tram and a few bus routes. The seed loads that file, so the feed itself
// (about 270 MB unzipped) is only needed to refresh the data.
//   node scripts/import-dubai-gtfs.js <unzipped GTFS folder> [--out <file.json>]...
// Feed: https://mobilitydatabase.org/feeds/mdb-3359 (mirror of the RTA dataset on Dubai Pulse, rta_gtfs-open).
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { haversineMeters } from '../src/utils/geo.js';
import { DAYS, fleetNeeded, median, parseCsvLine, readTable as readGtfsTable, seconds } from './lib/gtfs.js';

/** GTFS route_short_name -> how RideTrack shows it. Metro and tram are TRAIN; route_type 3 is BUS. */
const PICK = {
  MRed1: { routeNo: 'Red', line: 'Metro Red Line', capacity: 643 },
  MRed2: { routeNo: 'Red', line: 'Metro Red Line', capacity: 643 },
  MGrn: { routeNo: 'Green', line: 'Metro Green Line', capacity: 643 },
  T1: { routeNo: 'Tram', line: 'Dubai Tram', capacity: 405 },
  C01: { capacity: 80 },
  27: { capacity: 80 },
  8: { capacity: 80 },
  X28: { capacity: 80 },
};
const RENAME = { 'EXPO Metro Station': 'Expo 2020 Metro Station' };
const MERGE_M = 500; // platforms / bays of one station closer than this become one stop

const args = process.argv.slice(2);
const dir = args[0];
const outs = args.flatMap((a, i) => (a === '--out' ? [args[i + 1]] : []));
if (!dir) {
  console.error('Usage: node scripts/import-dubai-gtfs.js <unzipped GTFS folder> [--out <file.json>]...');
  process.exit(1);
}
if (!outs.length) outs.push(new URL('../db/data/dubai-rta.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));

const readTable = (file) => readGtfsTable(dir, file);

/**
 * "centrepoint Metro Station 1" -> "Centrepoint Metro Station", "Gold Souq Bus Station 12" -> "Gold Souq Bus Station".
 * The trailing number is a platform or bay, except on stops like tram "Jumeirah Beach Residence 1" and "... 2", which
 * are two stations: a rail platform has a sibling stop id (same station code, ending 01 / 02).
 */
function cleanName(stop, isRail) {
  let n = stop.stop_name.replace(/\s+/g, ' ').replace(/\/ /g, '/').replace(/\s+\)/g, ')').trim();
  const id = stop.stop_id;
  const platform = isRail ? gtfsStops.has(`${id.slice(0, -2)}${id.endsWith('01') ? '02' : '01'}`) : /\b(Station|Stn|Stop)\b/i.test(n);
  if (platform) n = n.replace(/(?<=[A-Za-z])\d$|\s+\d+(-\d+)?$/, '').trim();
  n = n.replace(/\bstation\b/g, 'Station');
  n = RENAME[n] ?? n;
  return /^[a-z]{3,}/.test(n) ? n.charAt(0).toUpperCase() + n.slice(1) : n;
}
const tidyEnd = (s) => s.replace(/\bMS\b/g, 'Metro Station').replace(/\bStn\b/g, 'Station').replace(/\s+/g, ' ').trim();

const routes = readTable('routes.txt').filter((r) => PICK[r.route_short_name]);
const routeById = new Map(routes.map((r) => [r.route_id, r]));
const trips = readTable('trips.txt').filter((t) => routeById.has(t.route_id));
const tripById = new Map(trips.map((t) => [t.trip_id, t]));
const calendar = Object.fromEntries(readTable('calendar.txt').map((c) => [c.service_id, DAYS.map((d) => (c[d] === '1' ? '1' : '0')).join('')]));
const gtfsStops = new Map(readTable('stops.txt').map((s) => [s.stop_id, s]));

// stop_times is the big file (1.4M rows): stream it and keep only the trips we picked
const stopTimes = new Map();
let header = null;
for await (const line of createInterface({ input: createReadStream(path.join(dir, 'stop_times.txt')) })) {
  if (!header) {
    header = parseCsvLine(line.replace(/^﻿/, ''));
    continue;
  }
  const f = parseCsvLine(line);
  if (!tripById.has(f[0])) continue;
  if (!stopTimes.has(f[0])) stopTimes.set(f[0], []);
  stopTimes.get(f[0]).push({ arrival: f[1], departure: f[2], stopId: f[3], seq: Number(f[4]) });
}

// One RideTrack route per GTFS route and direction, using that direction's most common stop pattern.
// Short workings (trips that start or end part-way) are left out.
const picked = [];
for (const r of routes) {
  for (const directionId of ['0', '1']) {
    const patterns = new Map();
    for (const t of trips.filter((x) => x.route_id === r.route_id && x.direction_id === directionId)) {
      const st = (stopTimes.get(t.trip_id) ?? []).sort((a, b) => a.seq - b.seq);
      if (st.length < 2 || !calendar[t.service_id]) continue;
      const key = st.map((s) => s.stopId).join('>');
      if (!patterns.has(key)) patterns.set(key, []);
      patterns.get(key).push({ trip: t, st });
    }
    const main = [...patterns.values()].sort((a, b) => b.length - a.length)[0];
    if (main) picked.push({ route: r, directionId, runs: main });
  }
}

// Stops: merge the platforms of one station (same cleaned name, close together) into a single stop, except where a
// route calls at both (e.g. two neighbouring bus stops with the same name): those stay separate.
const stops = [];
const stopIndex = new Map(); // GTFS stop_id -> index in `stops`
const unmerged = new Map(); // GTFS stop_id -> its own index, when merging clashed on some route
for (const p of picked) {
  const isRail = p.route.route_type !== '3';
  p.order = [];
  for (const { stopId } of p.runs[0].st) {
    const g = gtfsStops.get(stopId);
    const name = cleanName(g, isRail);
    const lat = Number(g.stop_lat);
    const lng = Number(g.stop_lon);
    const add = () => stops.push({ name, lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), zone: String(Number(g.zone_id)) }) - 1;
    let i = stopIndex.get(stopId);
    if (i === undefined) {
      i = stops.findIndex((s, k) => !p.order.includes(k) && s.name === name && haversineMeters(s.lat, s.lng, lat, lng) < MERGE_M);
      if (i < 0) i = add();
      stopIndex.set(stopId, i);
    } else if (p.order.includes(i)) {
      if (!unmerged.has(stopId)) unmerged.set(stopId, add());
      i = unmerged.get(stopId);
    }
    p.order.push(i);
  }
}

const out = [];
for (const { route, directionId, runs, order } of picked) {
  const pick = PICK[route.route_short_name];
  const isBus = route.route_type === '3';
  const first = runs[0].st;
  if (new Set(order).size !== order.length) throw new Error(`${route.route_short_name}: a stop appears twice on one route`);

  // running time from the first stop, per stop: the median over every trip of this pattern
  const offsets = first.map((_, i) => (i === 0 ? 0 : median(runs.map(({ st }) => seconds(st[i].arrival) - seconds(st[0].departure)))));
  const byDays = new Map();
  for (const { trip, st } of runs) {
    const days = calendar[trip.service_id];
    if (!byDays.has(days)) byDays.set(days, new Set());
    byDays.get(days).add(Math.round(seconds(st[0].departure) / 60));
  }
  const departures = [...byDays].map(([days, set]) => ({ days, times: [...set].sort((a, b) => a - b) }));
  const durationMin = Math.ceil(offsets.at(-1) / 60);

  let origin = stops[order[0]].name;
  let destination = stops[order.at(-1)].name;
  let name;
  if (isBus) {
    // the long name ("Airport Terminal 3 - Al Satwa Bus Stn") reads better than bus-bay stop names
    const halves = route.route_long_name.split(/\s+-\s+/).map(tidyEnd);
    if (halves.length === 2) [origin, destination] = directionId === '0' ? halves : [halves[1], halves[0]];
    name = `${origin} - ${destination}`;
  } else {
    origin = origin.replace(/ Metro Station$/, '');
    destination = destination.replace(/ Metro Station$/, '');
    name = `${pick.line} - ${origin} to ${destination}`;
  }

  out.push({
    gtfsRouteId: route.route_id,
    routeNo: pick.routeNo ?? route.route_short_name,
    name,
    mode: isBus ? 'BUS' : 'TRAIN',
    origin,
    destination,
    capacity: pick.capacity,
    fleet: Math.max(...departures.map((d) => fleetNeeded(d.times, durationMin))),
    regPrefix: `DXB-${route.route_short_name.toUpperCase()}${directionId === '0' ? 'A' : 'B'}`,
    stops: order.map((s, i) => [s, offsets[i]]),
    departures,
  });
}

const feed = readTable('calendar.txt');
const data = {
  source: 'Dubai RTA GTFS (https://mobilitydatabase.org/feeds/mdb-3359, licence: Dubai Pulse open data)',
  feedValid: `${feed[0].start_date}-${feed[0].end_date}`,
  generatedAt: new Date().toISOString().slice(0, 10),
  timeZone: 'Asia/Dubai',
  notes: 'stops[i] = [stop index, seconds from the first stop]; departures: days = Mon..Sun flags, times = minutes after midnight of the service day (can pass 1440)',
  stops,
  routes: out,
};
for (const file of outs) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data)}\n`);
  console.log(`Wrote ${file}`);
}
for (const r of out) {
  const total = r.departures.reduce((n, d) => n + d.times.length, 0);
  console.log(`${r.routeNo.padEnd(6)} ${r.name.padEnd(62)} ${String(r.stops.length).padStart(2)} stops, ${Math.round(r.stops.at(-1)[1] / 60)} min, ${total} timetable entries, fleet ${r.fleet}`);
}
console.log(`${stops.length} stops`);
