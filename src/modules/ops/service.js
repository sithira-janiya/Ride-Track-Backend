import { query } from '../../config/db.js';
import { badRequest } from '../../utils/errors.js';
import { describe } from '../vehicles/service.js';

/** Live picture for the authority dashboard (FR9): every reporting vehicle, recent delays and an occupancy summary. */
export async function dashboard() {
  const rows = await query(
    `SELECT v.*, r.route_no, r.mode FROM vehicles v JOIN routes r ON r.route_id = v.route_id
      WHERE v.is_active = TRUE ORDER BY r.route_no, v.vehicle_id`,
  );
  const vehicles = (
    await Promise.all(
      rows.map(async (v) => {
        const d = await describe(v);
        return d && { ...d, routeId: v.route_id, routeNo: v.route_no, mode: v.mode };
      }),
    )
  ).filter(Boolean);

  const alerts = await query(
    `SELECT * FROM delay_alerts WHERE type IN ('DELAY','CANCELLATION') AND created_at > UTC_TIMESTAMP() - INTERVAL 12 HOUR
      ORDER BY created_at DESC, alert_id DESC LIMIT 50`,
  );
  const activeDelays = alerts.map((a) => ({
    alertId: a.alert_id,
    tripId: a.trip_id,
    type: a.type,
    message: a.message,
    delayMinutes: a.delay_minutes,
    createdAt: new Date(a.created_at).toISOString(),
  }));

  const totalPassengers = vehicles.reduce((n, v) => n + (v.passengerCount ?? 0), 0);
  const totalCapacity = vehicles.reduce((n, v) => n + (v.capacity ?? 0), 0);
  const fullVehicles = vehicles.filter((v) => v.capacity && (v.passengerCount ?? 0) / v.capacity >= 0.9).length;
  return { vehicles, activeDelays, occupancy: { totalPassengers, totalCapacity, fullVehicles } };
}

const DAY_MS = 86400000;
const isoDay = (d) => d.toISOString().slice(0, 10);
const REPORT_TYPE = { ROUTE_PERFORMANCE: 'ROUTE', DELAYS: 'DELAY', OCCUPANCY: 'OCCUPANCY' };

/**
 * Builds a report for the given period and saves a `reports` row (DFD 7.3).
 * `from` and `to` are inclusive dates (YYYY-MM-DD); `routeId` narrows it to one route.
 */
export async function generateReport(officerId, { type, routeId, from, to }) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T23:59:59Z`);
  if (end < start) throw badRequest('The end date must not be before the start date.');
  if ((end - start) / DAY_MS > 366) throw badRequest('Choose a period of one year or less.');

  const routeFilter = routeId ? 'AND tr.route_id = ?' : '';
  const rp = routeId ? [routeId] : [];
  let report;

  if (type === 'ROUTE_PERFORMANCE') {
    // on-time = trips that were not delayed or cancelled; tickets sold = paid tickets (not cancelled, expired-unpaid or pending)
    const rows = await query(
      `SELECT r.route_no, r.name,
              COUNT(DISTINCT tr.trip_id) AS trips,
              SUM(tr.status NOT IN ('DELAYED','CANCELLED')) AS on_time_trips,
              COUNT(DISTINCT CASE WHEN t.status IN ('ACTIVE','USED') THEN t.ticket_id END) AS tickets
         FROM routes r JOIN trips tr ON tr.route_id = r.route_id AND tr.start_time BETWEEN ? AND ? ${routeFilter}
         LEFT JOIN tickets t ON t.trip_id = tr.trip_id
        GROUP BY r.route_id ORDER BY r.route_no`,
      [start, end, ...rp],
    );
    report = {
      title: 'Route performance',
      columns: ['On-time %', 'Trips', 'Tickets sold'],
      chartColumn: 0,
      unit: '%',
      rows: rows.map((r) => ({
        label: `${r.route_no} ${r.name}`,
        values: [r.trips ? Math.round((Number(r.on_time_trips) / r.trips) * 100) : 0, Number(r.trips), Number(r.tickets)],
      })),
    };
  } else if (type === 'DELAYS') {
    const rows = await query(
      `SELECT DATE(a.created_at) AS day, COUNT(*) AS n, ROUND(AVG(a.delay_minutes)) AS avg_min
         FROM delay_alerts a JOIN trips tr ON tr.trip_id = a.trip_id
        WHERE a.type = 'DELAY' AND a.created_at BETWEEN ? AND ? ${routeFilter}
        GROUP BY DATE(a.created_at)`,
      [start, end, ...rp],
    );
    const byDay = new Map(rows.map((r) => [isoDay(new Date(r.day)), r]));
    const days = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY_MS) + 1;
    report = {
      title: 'Delays by day',
      columns: ['Delayed trips', 'Avg delay (min)'],
      chartColumn: 0,
      unit: 'trips',
      rows: Array.from({ length: days }, (_, i) => {
        const d = new Date(start.getTime() + i * DAY_MS);
        const hit = byDay.get(isoDay(d));
        return { label: d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' }), values: [hit ? Number(hit.n) : 0, hit ? Number(hit.avg_min ?? 0) : 0] };
      }),
    };
  } else {
    const rows = await query(
      `SELECT r.route_no, r.name, AVG(o.passenger_count / v.capacity) AS avg_ratio, MAX(o.passenger_count / v.capacity) AS peak_ratio
         FROM occupancy_log o JOIN vehicles v ON v.vehicle_id = o.vehicle_id JOIN routes r ON r.route_id = v.route_id
        WHERE o.recorded_at BETWEEN ? AND ? ${routeId ? 'AND r.route_id = ?' : ''}
        GROUP BY r.route_id ORDER BY r.route_no`,
      [start, end, ...rp],
    );
    report = {
      title: 'Occupancy by route',
      columns: ['Average %', 'Peak %'],
      chartColumn: 0,
      unit: '%',
      rows: rows.map((r) => ({ label: `${r.route_no} ${r.name}`, values: [Math.round(r.avg_ratio * 100), Math.min(100, Math.round(r.peak_ratio * 100))] })),
    };
  }

  await query('INSERT INTO reports (generated_by, route_id, report_type, period_start, period_end) VALUES (?, ?, ?, ?, ?)', [
    officerId, routeId ?? null, REPORT_TYPE[type], from, to,
  ]);
  return { type, from, to, ...report };
}
