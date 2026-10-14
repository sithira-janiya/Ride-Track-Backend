import cron from 'node-cron';

import { isMssql, query } from '../config/db.js';
import { env } from '../config/env.js';
import { emitOpsUpdate } from '../realtime/index.js';
import { publishAlert } from '../modules/alerts/service.js';
import { getRouteStops } from '../modules/routes/stops.js';
import { fillTimetable } from '../modules/routes/timetable.js';
import { getLivePosition } from '../modules/vehicles/positions.js';
import { liveEta, scheduledEta, stopOffsets } from '../utils/eta.js';

const DELAY_THRESHOLD_MIN = 10;

/** Moves trips through SCHEDULED -> ONGOING -> COMPLETED by the clock. Delayed trips finish too. */
export async function advanceTrips() {
  const now = new Date();
  const a = await query("UPDATE trips SET status = 'ONGOING' WHERE status = 'SCHEDULED' AND start_time <= ? AND (end_time IS NULL OR end_time > ?)", [now, now]);
  const b = await query("UPDATE trips SET status = 'COMPLETED' WHERE status IN ('SCHEDULED','ONGOING','DELAYED') AND end_time IS NOT NULL AND end_time <= ?", [now]);
  if (a.affectedRows || b.affectedRows) emitOpsUpdate('trip');
}

/**
 * Housekeeping for tickets:
 *  - unpaid tickets older than 30 minutes expire (and their payment is marked failed),
 *  - tickets for cancelled trips are cancelled and refunded,
 *  - unused tickets for finished trips expire.
 */
export async function expireTickets() {
  const unpaidBefore = new Date(Date.now() - 30 * 60000);
  await query(
    "UPDATE payments SET status = 'FAILED' WHERE status = 'PENDING' AND ticket_id IN (SELECT ticket_id FROM tickets WHERE status = 'PENDING' AND issued_at < ?)",
    [unpaidBefore],
  );
  await query("UPDATE tickets SET status = 'EXPIRED' WHERE status = 'PENDING' AND issued_at < ?", [unpaidBefore]);
  await query(
    `UPDATE payments SET status = 'REFUNDED' WHERE status = 'PAID' AND ticket_id IN
       (SELECT t.ticket_id FROM tickets t JOIN trips tr ON tr.trip_id = t.trip_id WHERE tr.status = 'CANCELLED' AND t.status = 'ACTIVE')`,
  );
  await query("UPDATE tickets SET status = 'CANCELLED' WHERE status = 'ACTIVE' AND trip_id IN (SELECT trip_id FROM trips WHERE status = 'CANCELLED')");
  await query("UPDATE tickets SET status = 'EXPIRED' WHERE status = 'ACTIVE' AND trip_id IN (SELECT trip_id FROM trips WHERE status = 'COMPLETED')");
}

/**
 * Delay detection (FR8): for each running trip with a live vehicle, compare the live ETA at the last stop with the
 * timetable. A gap of 10+ minutes raises one DELAY alert per trip per hour.
 */
export async function detectDelays() {
  const trips = await query(
    `SELECT tr.trip_id, tr.route_id, tr.vehicle_id, tr.start_time, r.mode, r.route_no
       FROM trips tr JOIN routes r ON r.route_id = tr.route_id
      WHERE tr.status IN ('ONGOING','DELAYED')
        AND NOT EXISTS (SELECT 1 FROM delay_alerts a WHERE a.trip_id = tr.trip_id AND a.type = 'DELAY' AND a.created_at > ?)`,
    [new Date(Date.now() - 60 * 60000)],
  );
  for (const t of trips) {
    const pos = await getLivePosition(t.vehicle_id, env.livePositionMaxAgeMs);
    if (!pos) continue;
    const stops = await getRouteStops(t.route_id);
    if (stops.length < 2) continue;
    const offsets = stopOffsets(stops, t.mode);
    const last = stops.length - 1;
    const live = liveEta(pos, stops, offsets, last, t.mode);
    if (!live) continue;
    const late = Math.round((live.getTime() - scheduledEta(new Date(t.start_time), offsets, last).getTime()) / 60000);
    if (late >= DELAY_THRESHOLD_MIN) {
      await publishAlert({ tripId: t.trip_id, type: 'DELAY', message: `Route ${t.route_no} is running about ${late} minutes late.`, delayMinutes: late });
    }
  }
}

/** Keeps the next 12 hours of every route's timetable turned into trips, so arrivals never run dry. */
export async function extendTimetable() {
  const now = Date.now();
  await fillTimetable(new Date(now), new Date(now + 12 * 3600000), now);
}

/** Raw GPS rows are bulky; keep 90 days (docs/06-database-mysql.md). */
export async function purgeOldLocations() {
  const before = new Date(Date.now() - 90 * 86400000);
  // in batches, so one run never holds a long lock on the busiest table
  await query(isMssql ? 'DELETE TOP (50000) FROM location_log WHERE recorded_at < ?' : 'DELETE FROM location_log WHERE recorded_at < ? LIMIT 50000', [before]);
}

const safely = (name, fn) => () => fn().catch((e) => console.error(`job ${name} failed:`, e.message));

/** Starts the scheduled jobs. Returns a function that stops them (used on shutdown). */
export function startJobs() {
  const tasks = [
    cron.schedule('* * * * *', safely('advanceTrips', advanceTrips)),
    cron.schedule('* * * * *', safely('expireTickets', expireTickets)),
    cron.schedule('*/2 * * * *', safely('detectDelays', detectDelays)),
    cron.schedule('7 * * * *', safely('extendTimetable', extendTimetable)),
    cron.schedule('30 3 * * *', safely('purgeOldLocations', purgeOldLocations)),
  ];
  safely('extendTimetable', extendTimetable)(); // also on start, in case the server was down for a while
  return () => tasks.forEach((t) => t.stop());
}
