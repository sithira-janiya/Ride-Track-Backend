import cron from 'node-cron';

import { query } from '../config/db.js';
import { env } from '../config/env.js';
import { emitOpsUpdate } from '../realtime/index.js';
import { publishAlert } from '../modules/alerts/service.js';
import { getRouteStops } from '../modules/routes/stops.js';
import { getLivePosition } from '../modules/vehicles/positions.js';
import { cumulativeMeters, liveEta, scheduledEta } from '../utils/eta.js';

const DELAY_THRESHOLD_MIN = 10;

/** Moves trips through SCHEDULED -> ONGOING -> COMPLETED by the clock. Delayed trips finish too. */
export async function advanceTrips() {
  const a = await query("UPDATE trips SET status = 'ONGOING' WHERE status = 'SCHEDULED' AND start_time <= UTC_TIMESTAMP() AND (end_time IS NULL OR end_time > UTC_TIMESTAMP())");
  const b = await query("UPDATE trips SET status = 'COMPLETED' WHERE status IN ('SCHEDULED','ONGOING','DELAYED') AND end_time IS NOT NULL AND end_time <= UTC_TIMESTAMP()");
  if (a.affectedRows || b.affectedRows) emitOpsUpdate('trip');
}

/**
 * Housekeeping for tickets:
 *  - unpaid tickets older than 30 minutes expire (and their payment is marked failed),
 *  - tickets for cancelled trips are cancelled and refunded,
 *  - unused tickets for finished trips expire.
 */
export async function expireTickets() {
  await query(
    "UPDATE payments p JOIN tickets t ON t.ticket_id = p.ticket_id SET p.status = 'FAILED' WHERE t.status = 'PENDING' AND p.status = 'PENDING' AND t.issued_at < UTC_TIMESTAMP() - INTERVAL 30 MINUTE",
  );
  await query("UPDATE tickets SET status = 'EXPIRED' WHERE status = 'PENDING' AND issued_at < UTC_TIMESTAMP() - INTERVAL 30 MINUTE");
  await query("UPDATE payments p JOIN tickets t ON t.ticket_id = p.ticket_id JOIN trips tr ON tr.trip_id = t.trip_id SET p.status = 'REFUNDED' WHERE tr.status = 'CANCELLED' AND t.status = 'ACTIVE' AND p.status = 'PAID'");
  await query("UPDATE tickets t JOIN trips tr ON tr.trip_id = t.trip_id SET t.status = 'CANCELLED' WHERE tr.status = 'CANCELLED' AND t.status = 'ACTIVE'");
  await query("UPDATE tickets t JOIN trips tr ON tr.trip_id = t.trip_id SET t.status = 'EXPIRED' WHERE tr.status = 'COMPLETED' AND t.status = 'ACTIVE'");
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
        AND NOT EXISTS (SELECT 1 FROM delay_alerts a WHERE a.trip_id = tr.trip_id AND a.type = 'DELAY' AND a.created_at > UTC_TIMESTAMP() - INTERVAL 60 MINUTE)`,
  );
  for (const t of trips) {
    const pos = await getLivePosition(t.vehicle_id, env.livePositionMaxAgeMs);
    if (!pos) continue;
    const stops = await getRouteStops(t.route_id);
    if (stops.length < 2) continue;
    const cum = cumulativeMeters(stops);
    const last = stops.length - 1;
    const live = liveEta(pos, stops, cum, last, t.mode);
    if (!live) continue;
    const late = Math.round((live.getTime() - scheduledEta(new Date(t.start_time), cum, last, t.mode).getTime()) / 60000);
    if (late >= DELAY_THRESHOLD_MIN) {
      await publishAlert({ tripId: t.trip_id, type: 'DELAY', message: `Route ${t.route_no} is running about ${late} minutes late.`, delayMinutes: late });
    }
  }
}

/** Raw GPS rows are bulky; keep 90 days (docs/06-database-mysql.md). */
export async function purgeOldLocations() {
  await query('DELETE FROM location_log WHERE recorded_at < UTC_TIMESTAMP() - INTERVAL 90 DAY LIMIT 50000');
}

const safely = (name, fn) => () => fn().catch((e) => console.error(`job ${name} failed:`, e.message));

/** Starts the scheduled jobs. Returns a function that stops them (used on shutdown). */
export function startJobs() {
  const tasks = [
    cron.schedule('* * * * *', safely('advanceTrips', advanceTrips)),
    cron.schedule('* * * * *', safely('expireTickets', expireTickets)),
    cron.schedule('*/2 * * * *', safely('detectDelays', detectDelays)),
    cron.schedule('30 3 * * *', safely('purgeOldLocations', purgeOldLocations)),
  ];
  return () => tasks.forEach((t) => t.stop());
}
