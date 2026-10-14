// Builds a region's data file (db/data/<city>.json) from a city's GTFS feed: real stops, stop order, running times,
// departure timetables and, where the feed has them, fares. The seed loads that file, so the feed is only needed to
// refresh the data. What to take from each feed is set in scripts/gtfs-cities.js.
//   node scripts/import-gtfs.js <unzipped GTFS folder> --city hong-kong|kuala-lumpur [--out <file.json>]...
// Handles both kinds of timetable: one trip per departure, and frequencies.txt ("every 3 minutes from 06:00 to 09:00").
// Stops without times are timed by distance between the timed stops either side, as GTFS intends.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { haversineMeters } from '../src/utils/geo.js';
import { CITIES } from './gtfs-cities.js';
import { DAYS, fleetNeeded, median, readTable, seconds, streamTable } from './lib/gtfs.js';

const MERGE_M = 500; // platforms / bays of one station closer than this become one stop

const { values, positionals } = parseArgs({ allowPositionals: true, options: { city: { type: 'string' }, out: { type: 'string', multiple: true } } });
const dir = positionals[0];
const city = CITIES[values.city];
if (!dir || !city) {
  console.error(`Usage: node scripts/import-gtfs.js <unzipped GTFS folder> --city ${Object.keys(CITIES).join('|')} [--out <file.json>]...`);
  process.exit(1);
}
const outs = values.out?.length ? values.out : [path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', city.out)];
const has = (file) => existsSync(path.join(dir, file));

// ---- read the feed ----

const routes = readTable(dir, 'routes.txt').filter((r) => city.pick(r));
const routeById = new Map(routes.map((r) => [r.route_id, r]));
const trips = readTable(dir, 'trips.txt').filter((t) => routeById.has(t.route_id));
const tripById = new Map(trips.map((t) => [t.trip_id, t]));
const calendar = Object.fromEntries(readTable(dir, 'calendar.txt').map((c) => [c.service_id, DAYS.map((d) => (c[d] === '1' ? '1' : '0')).join('')]));
const gtfsStops = new Map(readTable(dir, 'stops.txt').map((s) => [s.stop_id, s]));

const stopTimes = new Map(); // trip_id -> [{ stopId, seq, arrival, departure }]
await streamTable(dir, 'stop_times.txt', (r) => {
  if (!tripById.has(r.trip_id)) return;
  if (!stopTimes.has(r.trip_id)) stopTimes.set(r.trip_id, []);
  stopTimes.get(r.trip_id).push({ stopId: r.stop_id, seq: Number(r.stop_sequence), arrival: seconds(r.arrival_time), departure: seconds(r.departure_time) });
});

const frequencies = new Map(); // trip_id -> [{ start, end, headway }]
if (has('frequencies.txt')) {
  for (const f of readTable(dir, 'frequencies.txt')) {
    if (!tripById.has(f.trip_id)) continue;
    if (!frequencies.has(f.trip_id)) frequencies.set(f.trip_id, []);
    frequencies.get(f.trip_id).push({ start: seconds(f.start_time), end: seconds(f.end_time), headway: Number(f.headway_secs) });
  }
}

const stopPos = (id) => {
  const s = gtfsStops.get(id);
  return [Number(s.stop_lat), Number(s.stop_lon)];
};

/** Seconds from the first stop for every stop of a trip. Untimed stops are placed by distance between timed ones. */
function tripOffsets(st) {
  const dist = [0];
  for (let i = 1; i < st.length; i += 1) dist.push(dist[i - 1] + haversineMeters(...stopPos(st[i - 1].stopId), ...stopPos(st[i].stopId)));
  const t = st.map((s) => s.arrival ?? s.departure);
  if (t[0] === null || t.at(-1) === null) return null;
  for (let i = 1; i < st.length - 1; i += 1) {
    if (t[i] !== null) continue;
    let j = i + 1;
    while (t[j] === null) j += 1;
    const k = i - 1; // the timed stop before i (filled in order, so always timed)
    const share = dist[j] === dist[k] ? 0 : (dist[i] - dist[k]) / (dist[j] - dist[k]);
    t[i] = t[k] + share * (t[j] - t[k]);
  }
  const start = st[0].departure ?? t[0];
  return t.map((x, i) => (i === 0 ? 0 : Math.max(0, Math.round(x - start))));
}

/** Minutes after midnight this trip leaves its first stop: one per run, or one per headway for frequency trips. */
function tripStarts(trip, st) {
  const freq = frequencies.get(trip.trip_id);
  if (!freq) return [Math.round((st[0].departure ?? st[0].arrival) / 60)];
  const out = [];
  for (const f of freq) for (let s = f.start; s < f.end; s += f.headway) out.push(Math.round(s / 60));
  return out;
}

// ---- one RideTrack route per GTFS route and direction, using that direction's busiest stop pattern ----

const picked = [];
for (const r of routes) {
  const byDirection = new Map();
  for (const t of trips.filter((x) => x.route_id === r.route_id)) {
    const st = (stopTimes.get(t.trip_id) ?? []).sort((a, b) => a.seq - b.seq);
    if (st.length < 2 || !calendar[t.service_id]) continue;
    const offsets = tripOffsets(st);
    if (!offsets) continue;
    const dirId = t.direction_id || city.direction(t) || '0';
    const key = st.map((s) => s.stopId).join('>');
    if (!byDirection.has(dirId)) byDirection.set(dirId, new Map());
    const patterns = byDirection.get(dirId);
    if (!patterns.has(key)) patterns.set(key, []);
    patterns.get(key).push({ trip: t, st, offsets, starts: tripStarts(t, st) });
  }
  for (const [directionId, patterns] of [...byDirection].sort()) {
    const runsOf = (p) => p.reduce((n, x) => n + x.starts.length, 0);
    const main = [...patterns.values()].sort((a, b) => runsOf(b) - runsOf(a))[0];
    if (main) picked.push({ route: r, directionId, runs: main });
  }
}
if (!picked.length) throw new Error('No routes picked: check the city config against routes.txt');

// ---- stops: merge the platforms of one station (same name, close together), unless a route calls at both ----

const stops = [];
const stopIndex = new Map();
const unmerged = new Map();
for (const p of picked) {
  p.order = [];
  for (const { stopId } of p.runs[0].st) {
    const g = gtfsStops.get(stopId);
    const name = city.stopName(g, p.route);
    const [lat, lng] = stopPos(stopId);
    const add = () => stops.push({ name, lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), zone: null }) - 1;
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

// ---- fares: what a rider pays when boarding at each stop (Hong Kong section fares) ----

const fareChecks = { boarding: 0, differs: 0 };
if (city.fares === 'gtfs') {
  const wanted = new Map(); // `${route}|${origin}|${destination}` -> fare_id
  const routeIds = new Set(picked.map((p) => p.route.route_id));
  await streamTable(dir, 'fare_rules.txt', (r) => {
    if (routeIds.has(r.route_id)) wanted.set(`${r.route_id}|${r.origin_id}|${r.destination_id}`, r.fare_id);
  });
  const fareIds = new Set(wanted.values());
  const price = new Map();
  await streamTable(dir, 'fare_attributes.txt', (r) => {
    if (fareIds.has(r.fare_id)) price.set(r.fare_id, Number(r.price));
  });
  const fare = (routeId, a, b) => price.get(wanted.get(`${routeId}|${a}|${b}`));
  for (const p of picked) {
    const ids = p.runs[0].st.map((s) => s.stopId);
    p.fares = ids.map((id, k) => {
      if (k === ids.length - 1) return 0;
      const toNext = fare(p.route.route_id, id, ids[k + 1]);
      const toEnd = fare(p.route.route_id, id, ids.at(-1));
      fareChecks.boarding += 1;
      if (toNext !== undefined && toEnd !== undefined && toNext !== toEnd) fareChecks.differs += 1;
      return toEnd ?? toNext ?? null;
    });
    // a stop missing from the fare table pays what the stop before it pays
    for (let k = 0; k < p.fares.length - 1; k += 1) if (p.fares[k] === null) p.fares[k] = k ? p.fares[k - 1] : 0;
  }
}

// ---- write ----

const out = [];
for (const { route, directionId, runs, order, fares } of picked) {
  const pick = city.pick(route);
  if (new Set(order).size !== order.length) throw new Error(`${route.route_short_name}: a stop appears twice on one route`);
  const offsets = runs[0].offsets.map((_, i) => (i === 0 ? 0 : median(runs.map((x) => x.offsets[i]))));
  const byDays = new Map();
  for (const { trip, starts } of runs) {
    const days = calendar[trip.service_id];
    if (!byDays.has(days)) byDays.set(days, new Set());
    for (const m of starts) byDays.get(days).add(m);
  }
  const departures = [...byDays].map(([days, set]) => ({ days, times: [...set].sort((a, b) => a - b) }));
  const durationMin = Math.ceil(offsets.at(-1) / 60);
  const origin = stops[order[0]].name;
  const destination = stops[order.at(-1)].name;
  const routeNo = pick.routeNo ?? route.route_short_name;
  out.push({
    gtfsRouteId: route.route_id,
    routeNo,
    name: `${pick.line ?? routeNo} - ${origin} to ${destination}`,
    mode: pick.mode ?? (route.route_type === '3' ? 'BUS' : 'TRAIN'),
    origin,
    destination,
    capacity: pick.capacity,
    fleet: Math.max(...departures.map((d) => fleetNeeded(d.times, durationMin))),
    regPrefix: city.regPrefix(route, directionId),
    stops: order.map((s, i) => (fares ? [s, offsets[i], fares[i]] : [s, offsets[i]])),
    departures,
  });
}

const feed = readTable(dir, 'calendar.txt');
const data = {
  region: city.region,
  source: city.source,
  licence: city.licence,
  feedValid: `${feed.map((c) => c.start_date).sort()[0]}-${feed.map((c) => c.end_date).sort().at(-1)}`,
  generatedAt: new Date().toISOString().slice(0, 10),
  notes:
    'stops[i] = [stop index, seconds from the first stop, fare when boarding there (if the feed has fares)]; departures: days = Mon..Sun flags, times = minutes after midnight of the service day (can pass 1440)',
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
  console.log(`${r.routeNo.padEnd(10)} ${r.name.slice(0, 70).padEnd(70)} ${String(r.stops.length).padStart(3)} stops, ${Math.round(r.stops.at(-1)[1] / 60)} min, ${total} departures/week-pattern, fleet ${r.fleet}`);
}
console.log(`${stops.length} stops`);
if (fareChecks.boarding) console.log(`Fares: ${fareChecks.differs} of ${fareChecks.boarding} boarding stops charge differently by destination (boarding fare to the last stop is used)`);
