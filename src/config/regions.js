import { haversineMeters } from '../utils/geo.js';

/**
 * The areas RideTrack serves. A route belongs to one region, which sets the clock its timetable runs on, the currency
 * of its fares and how a fare is worked out (`fareModel`):
 *   STOP_DIFFERENCE  the difference between the stops' fare_from_origin (Sri Lanka)
 *   ZONE             `zoneFares` is the fare for a trip touching 1, 2 or 3+ fare zones (Dubai RTA, Nol Silver)
 *   BOARDING         the fare depends only on the stop you board at, stored in that stop's fare_from_origin
 *                    (Hong Kong section fares: the fare to any later stop)
 *   DISTANCE         `distanceFare.base` plus `perKm` along the route, capped at `max` (Kuala Lumpur: the feed has
 *                    no fares, so these are estimates, not Prasarana's fare table)
 * `source` credits the open data a region's routes come from.
 */
export const REGIONS = {
  SRI_LANKA: { name: 'Sri Lanka', timeZone: 'Asia/Colombo', currency: 'LKR', fareModel: 'STOP_DIFFERENCE', source: null },
  DUBAI: {
    name: 'Dubai',
    timeZone: 'Asia/Dubai',
    currency: 'AED',
    fareModel: 'ZONE',
    zoneFares: [3, 5, 7.5],
    source: 'Roads and Transport Authority (RTA), Dubai Pulse open data',
  },
  HONG_KONG: {
    name: 'Hong Kong',
    timeZone: 'Asia/Hong_Kong',
    currency: 'HKD',
    fareModel: 'BOARDING',
    source: 'Transport Department, DATA.GOV.HK',
  },
  KUALA_LUMPUR: {
    name: 'Kuala Lumpur',
    timeZone: 'Asia/Kuala_Lumpur',
    currency: 'MYR',
    fareModel: 'DISTANCE',
    distanceFare: { base: 1.2, perKm: 0.15, max: 6.4 },
    source: 'Prasarana Malaysia, data.gov.my',
  },
};

export const REGION_CODES = Object.keys(REGIONS);

export const regionInfo = (code) => REGIONS[code] ?? REGIONS.SRI_LANKA;

/** Route length in km from `board` to `alight`, following the stops in between. */
function legKm(leg) {
  let m = 0;
  for (let i = 1; i < leg.length; i += 1) m += haversineMeters(leg[i - 1].latitude, leg[i - 1].longitude, leg[i].latitude, leg[i].longitude);
  return m / 1000;
}

/**
 * Fare from `board` to `alight` on a route whose ordered stops are `stops`
 * (each with stopSequence, fareFromOrigin, fareZone, latitude, longitude).
 */
export function fareBetween(region, stops, board, alight) {
  const { fareModel, zoneFares, distanceFare } = regionInfo(region);
  const leg = stops.filter((s) => s.stopSequence >= board.stopSequence && s.stopSequence <= alight.stopSequence);
  const round = (n) => Math.round(n * 100) / 100;
  if (fareModel === 'ZONE' && leg.every((s) => s.fareZone)) {
    const zones = new Set(leg.map((s) => s.fareZone)).size;
    return zoneFares[Math.min(zones, zoneFares.length) - 1];
  }
  if (fareModel === 'BOARDING') return round(Number(board.fareFromOrigin));
  if (fareModel === 'DISTANCE') {
    // to the nearest 10 sen, like the posted fares
    return round(Math.min(distanceFare.max, Math.round((distanceFare.base + distanceFare.perKm * legKm(leg)) * 10) / 10));
  }
  return round(alight.fareFromOrigin - board.fareFromOrigin);
}

/** Midnight of `date` (YYYY-MM-DD) in `timeZone`, as a UTC timestamp in ms. */
export function zonedMidnight(date, timeZone) {
  const guess = Date.parse(`${date}T00:00:00Z`);
  return guess - offsetMs(timeZone, guess);
}

/** The calendar day (YYYY-MM-DD) that `ms` falls on in `timeZone`. */
export const zonedDate = (ms, timeZone) => new Date(ms).toLocaleDateString('en-CA', { timeZone });

/** How far `timeZone` is ahead of UTC at instant `ms`. */
function offsetMs(timeZone, ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(ms)
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000;
}
