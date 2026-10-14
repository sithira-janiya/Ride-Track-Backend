import { fareBetween, zonedDate, zonedMidnight } from '../src/config/regions.js';
import { cumulativeMeters, liveEta, nextStopIndex, scheduledEta, SPEED_MPS, stopOffsets } from '../src/utils/eta.js';
import { boundingBox, haversineMeters } from '../src/utils/geo.js';

// three stops roughly in a line, about 1.1 km apart
const stops = [
  { latitude: 6.9, longitude: 79.85 },
  { latitude: 6.91, longitude: 79.85 },
  { latitude: 6.92, longitude: 79.85 },
];
const cum = cumulativeMeters(stops);
const bus = stopOffsets(stops, 'BUS');
// the same stops with timetabled running times (as imported from a GTFS feed): 5 and 12 minutes
const timed = stops.map((s, i) => ({ ...s, secondsFromOrigin: [0, 300, 720][i] }));

describe('geo', () => {
  it('measures distance between two points', () => {
    expect(Math.round(haversineMeters(6.9, 79.85, 6.91, 79.85))).toBeGreaterThan(1100);
    expect(Math.round(haversineMeters(6.9, 79.85, 6.91, 79.85))).toBeLessThan(1120);
    expect(haversineMeters(6.9, 79.85, 6.9, 79.85)).toBe(0);
  });

  it('builds a box that contains the point', () => {
    const b = boundingBox(6.9, 79.85, 1500);
    expect(b.minLat).toBeLessThan(6.9);
    expect(b.maxLat).toBeGreaterThan(6.9);
    expect(b.minLng).toBeLessThan(79.85);
    expect(b.maxLng).toBeGreaterThan(79.85);
  });
});

describe('ETA', () => {
  it('accumulates distance along the route', () => {
    expect(cum[0]).toBe(0);
    expect(cum[2]).toBeCloseTo(cum[1] * 2, -1);
  });

  it('adds travel time to the departure for the timetable ETA', () => {
    const start = new Date('2026-01-01T08:00:00Z');
    const eta = scheduledEta(start, bus, 2);
    expect((eta - start) / 1000).toBeCloseTo(cum[2] / SPEED_MPS.BUS, 0);
    expect(scheduledEta(start, bus, 0).getTime()).toBe(start.getTime());
  });

  it('uses the timetabled running times when every stop has one', () => {
    const start = new Date('2026-01-01T08:00:00Z');
    expect(stopOffsets(timed, 'BUS')).toEqual([0, 300, 720]);
    expect((scheduledEta(start, stopOffsets(timed, 'BUS'), 2) - start) / 1000).toBe(720);
    // one stop without a time: fall back to distance and speed
    expect(stopOffsets([...timed.slice(0, 2), stops[2]], 'BUS')).toEqual(bus);
  });

  it('finds the next stop ahead of the vehicle', () => {
    expect(nextStopIndex({ lat: 6.9, lng: 79.85 }, stops)).toBe(0); // at the first stop
    expect(nextStopIndex({ lat: 6.905, lng: 79.85 }, stops)).toBe(1); // between 0 and 1: next is 1
    expect(nextStopIndex({ lat: 6.915, lng: 79.85 }, stops)).toBe(2);
    expect(nextStopIndex({ lat: 6.92, lng: 79.85 }, stops)).toBe(2); // at the last stop
  });

  it('computes a live ETA for a stop ahead, and null for a stop already passed', () => {
    const now = new Date('2026-01-01T08:00:00Z');
    const pos = { lat: 6.905, lng: 79.85 }; // halfway to stop 1
    const toStop1 = liveEta(pos, stops, bus, 1, 'BUS', now);
    const toStop2 = liveEta(pos, stops, bus, 2, 'BUS', now);
    expect(toStop1 > now).toBe(true);
    expect(toStop2 > toStop1).toBe(true);
    expect(liveEta(pos, stops, bus, 0, 'BUS', now)).toBeNull();
  });

  it('follows the timetable from a live position: half a 5-minute leg left, then 7 more minutes', () => {
    const now = new Date('2026-01-01T08:00:00Z');
    const offsets = stopOffsets(timed, 'BUS');
    const pos = { lat: 6.905, lng: 79.85 };
    expect((liveEta(pos, timed, offsets, 1, 'BUS', now) - now) / 1000).toBeCloseTo(150, -1);
    expect((liveEta(pos, timed, offsets, 2, 'BUS', now) - now) / 1000).toBeCloseTo(150 + 420, -1);
  });

  it('is faster for trains than buses over the same distance', () => {
    const now = new Date('2026-01-01T08:00:00Z');
    const pos = { lat: 6.9, lng: 79.85 };
    expect(liveEta(pos, stops, stopOffsets(stops, 'TRAIN'), 2, 'TRAIN', now) < liveEta(pos, stops, bus, 2, 'BUS', now)).toBe(true);
  });
});

describe('regions', () => {
  const line = [
    { stopSequence: 1, fareFromOrigin: 0, fareZone: '5' },
    { stopSequence: 2, fareFromOrigin: 30, fareZone: '5' },
    { stopSequence: 3, fareFromOrigin: 50, fareZone: '6' },
    { stopSequence: 4, fareFromOrigin: 80, fareZone: '2' },
  ];

  it('charges Sri Lankan fares as the difference between the stops', () => {
    expect(fareBetween('SRI_LANKA', line, line[1], line[3])).toBe(50);
  });

  it('charges Dubai fares by the number of zones the trip touches', () => {
    expect(fareBetween('DUBAI', line, line[0], line[1])).toBe(3); // zone 5 only
    expect(fareBetween('DUBAI', line, line[0], line[2])).toBe(5); // 5 and 6
    expect(fareBetween('DUBAI', line, line[0], line[3])).toBe(7.5); // 3 zones or more
  });

  it('charges Hong Kong fares by the boarding stop only', () => {
    const hk = [
      { stopSequence: 1, fareFromOrigin: 34.6 },
      { stopSequence: 2, fareFromOrigin: 27.3 },
      { stopSequence: 3, fareFromOrigin: 0 },
    ];
    expect(fareBetween('HONG_KONG', hk, hk[0], hk[2])).toBe(34.6);
    expect(fareBetween('HONG_KONG', hk, hk[1], hk[2])).toBe(27.3);
  });

  it('estimates Kuala Lumpur fares from the distance along the route, capped', () => {
    // about 11.1 km per 0.1 degree of latitude
    const kl = [0, 0.05, 0.5].map((d, i) => ({ stopSequence: i + 1, latitude: 3 + d, longitude: 101.7 }));
    expect(fareBetween('KUALA_LUMPUR', kl, kl[0], kl[1])).toBe(2); // 1.2 + 0.15 x 5.6 km
    expect(fareBetween('KUALA_LUMPUR', kl, kl[0], kl[2])).toBe(6.4); // 55 km: the maximum
  });

  it('finds midnight and the calendar day in a time zone', () => {
    expect(new Date(zonedMidnight('2026-03-02', 'Asia/Dubai')).toISOString()).toBe('2026-03-01T20:00:00.000Z');
    expect(new Date(zonedMidnight('2026-03-02', 'Asia/Colombo')).toISOString()).toBe('2026-03-01T18:30:00.000Z');
    expect(zonedDate(Date.parse('2026-03-01T21:00:00Z'), 'Asia/Dubai')).toBe('2026-03-02');
    expect(zonedDate(Date.parse('2026-03-01T19:00:00Z'), 'Asia/Dubai')).toBe('2026-03-01');
  });
});
