import { cumulativeMeters, liveEta, nextStopIndex, scheduledEta, SPEED_MPS } from '../src/utils/eta.js';
import { boundingBox, haversineMeters } from '../src/utils/geo.js';

// three stops roughly in a line, about 1.1 km apart
const stops = [
  { latitude: 6.9, longitude: 79.85 },
  { latitude: 6.91, longitude: 79.85 },
  { latitude: 6.92, longitude: 79.85 },
];
const cum = cumulativeMeters(stops);

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
    const eta = scheduledEta(start, cum, 2, 'BUS');
    expect((eta - start) / 1000).toBeCloseTo(cum[2] / SPEED_MPS.BUS, 0);
    expect(scheduledEta(start, cum, 0, 'BUS').getTime()).toBe(start.getTime());
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
    const toStop1 = liveEta(pos, stops, cum, 1, 'BUS', now);
    const toStop2 = liveEta(pos, stops, cum, 2, 'BUS', now);
    expect(toStop1 > now).toBe(true);
    expect(toStop2 > toStop1).toBe(true);
    expect(liveEta(pos, stops, cum, 0, 'BUS', now)).toBeNull();
  });

  it('is faster for trains than buses over the same distance', () => {
    const now = new Date('2026-01-01T08:00:00Z');
    const pos = { lat: 6.9, lng: 79.85 };
    expect(liveEta(pos, stops, cum, 2, 'TRAIN', now) < liveEta(pos, stops, cum, 2, 'BUS', now)).toBe(true);
  });
});
