/**
 * The areas RideTrack serves. A route belongs to one region, which sets the clock its timetable runs on and the
 * currency of its fares. `zoneFares` (Dubai RTA, Nol Silver) is the fare for a trip touching 1, 2 or 3+ fare zones;
 * regions without it charge the difference between the stops' `fare_from_origin`.
 */
export const REGIONS = {
  SRI_LANKA: { name: 'Sri Lanka', timeZone: 'Asia/Colombo', currency: 'LKR', zoneFares: null },
  DUBAI: { name: 'Dubai', timeZone: 'Asia/Dubai', currency: 'AED', zoneFares: [3, 5, 7.5] },
};

export const REGION_CODES = Object.keys(REGIONS);

export const regionInfo = (code) => REGIONS[code] ?? REGIONS.SRI_LANKA;

/** Fare from `board` to `alight` on a route whose ordered stops are `stops` (each with stopSequence, fareFromOrigin, fareZone). */
export function fareBetween(region, stops, board, alight) {
  const { zoneFares } = regionInfo(region);
  const leg = stops.filter((s) => s.stopSequence >= board.stopSequence && s.stopSequence <= alight.stopSequence);
  if (zoneFares && leg.every((s) => s.fareZone)) {
    const zones = new Set(leg.map((s) => s.fareZone)).size;
    return zoneFares[Math.min(zones, zoneFares.length) - 1];
  }
  return Math.round((alight.fareFromOrigin - board.fareFromOrigin) * 100) / 100;
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
