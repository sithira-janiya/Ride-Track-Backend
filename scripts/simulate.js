// GPS simulator: moves each vehicle of every ongoing trip along its route and posts positions to the API,
// so the app's live map works without hardware.   npm run simulate   (the API must be running)
// Vehicles keep to the timetable between stops (the GTFS running times on Dubai routes). Positions go out in parallel
// batches, because at peak the Dubai routes alone have about 100 vehicles on the road.
import { closePool, query } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { getRouteStops } from '../src/modules/routes/stops.js';
import { stopOffsets } from '../src/utils/eta.js';

const API = process.env.SIM_API_URL ?? `http://localhost:${env.port}/api/v1`;
const EVERY_MS = Number(process.env.SIM_INTERVAL_MS ?? 3000);
const BATCH = 20;

/** Where a trip's vehicle is `elapsedSec` after leaving the first stop: between the two stops it is timetabled between. */
function positionAt(stops, offsets, elapsedSec) {
  const t = Math.min(Math.max(elapsedSec, 0), offsets.at(-1));
  const next = offsets.findIndex((o) => o > t); // -1: already at the last stop
  const i = next < 0 ? stops.length - 2 : Math.max(0, next - 1);
  const leg = offsets[i + 1] - offsets[i];
  const f = leg > 0 ? Math.min(1, (t - offsets[i]) / leg) : 1;
  return {
    lat: stops[i].latitude + (stops[i + 1].latitude - stops[i].latitude) * f,
    lng: stops[i].longitude + (stops[i + 1].longitude - stops[i].longitude) * f,
  };
}

async function post(vehicleId, pos) {
  const res = await fetch(`${API}/vehicles/${vehicleId}/location`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-key': env.deviceApiKey },
    body: JSON.stringify({ ...pos, recordedAt: new Date().toISOString() }),
  }).catch((e) => ({ ok: false, status: e.message }));
  if (!res.ok) console.warn(`vehicle ${vehicleId}: ${res.status}`);
}

async function tick() {
  // newest running trip per vehicle, so a vehicle is never in two places at once
  const trips = await query(
    `SELECT t.trip_id, t.route_id, t.vehicle_id, t.start_time, r.mode
       FROM trips t JOIN routes r ON r.route_id = t.route_id
      WHERE t.status IN ('ONGOING','DELAYED') AND t.end_time IS NOT NULL
      ORDER BY t.start_time DESC`,
  );
  const seen = new Set();
  const moves = [];
  for (const t of trips) {
    if (seen.has(t.vehicle_id)) continue;
    seen.add(t.vehicle_id);
    const stops = await getRouteStops(t.route_id);
    if (stops.length < 2) continue;
    moves.push([t.vehicle_id, positionAt(stops, stopOffsets(stops, t.mode), (Date.now() - new Date(t.start_time)) / 1000)]);
  }
  for (let i = 0; i < moves.length; i += BATCH) await Promise.all(moves.slice(i, i + BATCH).map(([id, pos]) => post(id, pos)));
  console.log(`${new Date().toLocaleTimeString()} sent ${moves.length} position(s)`);
}

console.log(`Simulating GPS every ${EVERY_MS / 1000}s to ${API}. Ctrl+C to stop.`);
process.on('SIGINT', async () => {
  await closePool();
  process.exit(0);
});
for (;;) {
  await tick().catch((e) => console.error('tick failed:', e.message));
  await new Promise((r) => setTimeout(r, EVERY_MS));
}
