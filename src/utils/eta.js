import { haversineMeters } from './geo.js';

/** Average cruising speed in metres per second, used when no recent speed is known. */
export const SPEED_MPS = { BUS: 20 / 3.6, TRAIN: 40 / 3.6 };

/** Cumulative distance along the route polyline: result[i] is metres from the first stop to stop i. */
export function cumulativeMeters(stops) {
  const out = [0];
  for (let i = 1; i < stops.length; i += 1) {
    out.push(out[i - 1] + haversineMeters(stops[i - 1].latitude, stops[i - 1].longitude, stops[i].latitude, stops[i].longitude));
  }
  return out;
}

/**
 * Timetabled running time from the first stop to each stop, in seconds. Uses the route's own times
 * (`secondsFromOrigin`, from the GTFS feed) when every stop has one, otherwise distance at the average speed.
 */
export function stopOffsets(stops, mode) {
  if (stops.length && stops.every((s) => s.secondsFromOrigin != null)) return stops.map((s) => Number(s.secondsFromOrigin));
  return cumulativeMeters(stops).map((m) => m / SPEED_MPS[mode]);
}

/** Timetable ETA at stop `idx` for a trip that left the origin at `startTime` (a Date). `offsets` from stopOffsets. */
export function scheduledEta(startTime, offsets, idx) {
  return new Date(startTime.getTime() + offsets[idx] * 1000);
}

/**
 * Index of the next stop the vehicle has yet to reach.
 * Nearest stop n; if the vehicle is already closer to n+1 than n is to n+1, it has passed n.
 */
export function nextStopIndex(pos, stops) {
  let n = 0;
  let best = Infinity;
  stops.forEach((s, i) => {
    const d = haversineMeters(pos.lat, pos.lng, s.latitude, s.longitude);
    if (d < best) {
      best = d;
      n = i;
    }
  });
  if (n < stops.length - 1) {
    const toNext = haversineMeters(pos.lat, pos.lng, stops[n + 1].latitude, stops[n + 1].longitude);
    const gap = haversineMeters(stops[n].latitude, stops[n].longitude, stops[n + 1].latitude, stops[n + 1].longitude);
    if (toNext < gap && best > 30) return n + 1; // 30 m: still "at" the stop
  }
  return n;
}

/**
 * Live ETA at `targetIdx` from a vehicle position. Returns null when the vehicle has already passed that stop.
 * `now` is a Date. The part of the current stop-to-stop leg still to go takes its share of that leg's timetabled
 * time, then the timetable runs on from the next stop.
 */
export function liveEta(pos, stops, offsets, targetIdx, mode, now = new Date()) {
  const next = nextStopIndex(pos, stops);
  if (targetIdx < next) return null;
  const toNext = haversineMeters(pos.lat, pos.lng, stops[next].latitude, stops[next].longitude);
  let toNextSec = toNext / SPEED_MPS[mode];
  if (next > 0) {
    const gap = haversineMeters(stops[next - 1].latitude, stops[next - 1].longitude, stops[next].latitude, stops[next].longitude);
    const leg = offsets[next] - offsets[next - 1];
    if (gap > 0) toNextSec = leg * Math.min(1, toNext / gap);
  }
  return new Date(now.getTime() + (toNextSec + offsets[targetIdx] - offsets[next]) * 1000);
}
