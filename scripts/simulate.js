// GPS simulator: moves each vehicle of every ongoing trip along its route and posts positions to the API,
// so the app's live map works without hardware.   npm run simulate   (the API must be running)
import { pool, query } from '../src/config/db.js';
import { env } from '../src/config/env.js';

const API = process.env.SIM_API_URL ?? `http://localhost:${env.port}/api/v1`;
const EVERY_MS = Number(process.env.SIM_INTERVAL_MS ?? 3000);

async function tick() {
  const trips = await query(
    `SELECT trip_id, route_id, vehicle_id, start_time, end_time FROM trips WHERE status IN ('ONGOING','DELAYED') AND end_time IS NOT NULL`,
  );
  const now = Date.now();
  for (const t of trips) {
    const stops = await query(
      'SELECT s.latitude, s.longitude FROM route_stops rs JOIN stops s ON s.stop_id = rs.stop_id WHERE rs.route_id = ? ORDER BY rs.stop_sequence',
      [t.route_id],
    );
    if (stops.length < 2) continue;
    const progress = Math.min(1, Math.max(0, (now - new Date(t.start_time)) / (new Date(t.end_time) - new Date(t.start_time))));
    const scaled = progress * (stops.length - 1);
    const i = Math.min(Math.floor(scaled), stops.length - 2);
    const f = scaled - i;
    const lat = stops[i].latitude + (stops[i + 1].latitude - stops[i].latitude) * f;
    const lng = stops[i].longitude + (stops[i + 1].longitude - stops[i].longitude) * f;
    const res = await fetch(`${API}/vehicles/${t.vehicle_id}/location`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-key': env.deviceApiKey },
      body: JSON.stringify({ lat, lng, recordedAt: new Date().toISOString() }),
    }).catch((e) => ({ ok: false, status: e.message }));
    if (!res.ok) console.warn(`vehicle ${t.vehicle_id}: ${res.status}`);
  }
  console.log(`${new Date().toLocaleTimeString()} sent ${trips.length} position(s)`);
}

console.log(`Simulating GPS every ${EVERY_MS / 1000}s to ${API}. Ctrl+C to stop.`);
process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});
for (;;) {
  await tick().catch((e) => console.error('tick failed:', e.message));
  await new Promise((r) => setTimeout(r, EVERY_MS));
}
