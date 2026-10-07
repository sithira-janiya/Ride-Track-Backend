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

/** Timetable ETA at stop `idx` for a trip that left the origin at `startTime` (a Date). */
export function scheduledEta(startTime, cumMeters, idx, mode) {
  return new Date(startTime.getTime() + (cumMeters[idx] / SPEED_MPS[mode]) * 1000);
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
 * `now` is a Date. Distance is the straight line to the next stop, then along the route.
 */
export function liveEta(pos, stops, cumMeters, targetIdx, mode, now = new Date()) {
  const next = nextStopIndex(pos, stops);
  if (targetIdx < next) return null;
  const toNext = haversineMeters(pos.lat, pos.lng, stops[next].latitude, stops[next].longitude);
  const meters = toNext + (cumMeters[targetIdx] - cumMeters[next]);
  return new Date(now.getTime() + (meters / SPEED_MPS[mode]) * 1000);
}
