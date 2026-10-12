import { insertMany, query } from '../../config/db.js';
import { regionInfo, zonedDate, zonedMidnight } from '../../config/regions.js';
import { emitOpsUpdate } from '../../realtime/index.js';
import { stopOffsets } from '../../utils/eta.js';
import { getRouteStops } from './stops.js';

const DAY_MS = 86400000;
const TURNAROUND_MS = 5 * 60000;

const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const weekday = (date) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday, matching service_days

/** A vehicle free for [start, end) plus turnaround, or else the one that frees up soonest. */
function pickVehicle(fleet, start, end) {
  const free = fleet.find((v) => v.busy.every(([s, e]) => e + TURNAROUND_MS <= start || s >= end + TURNAROUND_MS));
  return free ?? fleet.reduce((a, b) => (Math.max(...a.busy.map(([, e]) => e)) <= Math.max(...b.busy.map(([, e]) => e)) ? a : b));
}

/**
 * Creates the trips in each active route's timetable (`route_departures`) that start between `from` and `to`, in the
 * route's own time zone, and gives each one a free vehicle of that route. Trips that already exist are skipped, so it is
 * safe to run again (the seed and an hourly job both do). Returns how many trips were added.
 */
export async function fillTimetable(from, to, now = Date.now()) {
  const [routes, departures, vehicles, existing] = await Promise.all([
    query('SELECT route_id, region, mode FROM routes WHERE is_active = 1'),
    query('SELECT route_id, service_days, depart_minute FROM route_departures ORDER BY depart_minute'),
    query('SELECT vehicle_id, route_id FROM vehicles WHERE is_active = 1 ORDER BY vehicle_id'),
    query('SELECT route_id, vehicle_id, start_time, end_time FROM trips WHERE start_time BETWEEN ? AND ?', [new Date(from.getTime() - DAY_MS), to]),
  ]);

  const rows = [];
  for (const route of routes) {
    const deps = departures.filter((d) => d.route_id === route.route_id);
    const fleet = vehicles.filter((v) => v.route_id === route.route_id).map((v) => ({ id: v.vehicle_id, busy: [] }));
    const stops = deps.length && fleet.length ? await getRouteStops(route.route_id) : [];
    if (stops.length < 2) continue;
    const durationMs = Math.round(stopOffsets(stops, route.mode).at(-1)) * 1000;

    const taken = new Set();
    for (const t of existing.filter((x) => x.route_id === route.route_id)) {
      const start = new Date(t.start_time).getTime();
      taken.add(start);
      fleet.find((v) => v.id === t.vehicle_id)?.busy.push([start, t.end_time ? new Date(t.end_time).getTime() : start + durationMs]);
    }

    const { timeZone } = regionInfo(route.region);
    // departures after midnight (minute 1440+) belong to the previous service day, so begin a day early
    for (let day = zonedDate(from.getTime() - DAY_MS, timeZone); zonedMidnight(day, timeZone) < to.getTime(); day = nextDay(day)) {
      const midnight = zonedMidnight(day, timeZone);
      for (const d of deps) {
        const start = midnight + d.depart_minute * 60000;
        if (d.service_days[weekday(day)] !== '1' || start < from.getTime() || start >= to.getTime() || taken.has(start)) continue;
        const end = start + durationMs;
        const vehicle = pickVehicle(fleet, start, end);
        vehicle.busy.push([start, end]);
        taken.add(start);
        rows.push([route.route_id, vehicle.id, new Date(start), new Date(end), end <= now ? 'COMPLETED' : start <= now ? 'ONGOING' : 'SCHEDULED']);
      }
    }
  }

  await insertMany('trips', ['route_id', 'vehicle_id', 'start_time', 'end_time', 'status'], rows);
  if (rows.length) emitOpsUpdate('trip');
  return rows.length;
}
