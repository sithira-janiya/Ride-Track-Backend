// What scripts/import-gtfs.js takes from each city's GTFS feed, and how it names things.
//   pick(route)      -> { routeNo?, line?, mode?, capacity } for routes to import, or null
//   direction(trip)  -> '0' / '1' when the feed has no direction_id
//   stopName(stop, route) -> the name riders know
//   fares            'gtfs' reads the fare a rider pays when boarding at each stop from fare_rules / fare_attributes
//   regPrefix(route, directionId) -> vehicle registration prefix ("HK-A21-A" -> HK-A21-A-01, -02, ...)

const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(Mtr|Lrt|Mrt|Brt|Bbi|Kl|Klcc|Ktm|Usj|Ss|Pj|Hkust|Ifc|Ii|Iii)(?=\b|\d)/g, (w) => w.toUpperCase())
    .replace(/\b(USJ|SS|PJ)(\d)/g, '$1 $2')
    .replace(/'S\b/g, "'s");

// Hong Kong: the Transport Department's feed (buses, minibuses, trams, ferries; MTR rail is not in it).
// A handful of well-known routes: the tram's full line, the Peak Tram, the airport bus A21 and city buses.
// `code` names the vehicles (HK-<code>-A-01): KMB and Citybus both run a route 6.
const HK_PICK = {
  4007: { routeNo: 'Tram', line: 'Hong Kong Tramways', code: 'TRAM', mode: 'TRAIN', capacity: 115 },
  5001: { routeNo: 'Peak Tram', line: 'Peak Tram', code: 'PEAK', mode: 'TRAIN', capacity: 210 },
  1673: { line: 'Citybus A21', code: 'CTBA21', capacity: 130 }, // Hung Hom Station - Airport
  1053: { line: 'KMB 1A', code: 'KMB1A', capacity: 130 }, // Sau Mau Ping - Star Ferry
  1253: { line: 'KMB 6', code: 'KMB6', capacity: 130 }, // Star Ferry - Lai Chi Kok
  1000708: { line: 'Citybus 6', code: 'CTB6', capacity: 130 }, // Stanley Village - Central
};
const HK_RENAME = { 'Kennnedy Town Terminus': 'Kennedy Town Terminus' }; // typo in the feed

// "[CTB] HIU TSUI STREET, SIU SAI WAN ROAD|[KMB] HIU TSUI STREET" -> the name the route's own operator uses
function hkStopName(stop, route) {
  const parts = stop.stop_name.split('|').map((p) => {
    const m = p.match(/^\[([^\]]+)\]\s*(.*)$/);
    return m ? { agency: m[1], name: m[2] } : { agency: null, name: p };
  });
  const own = parts.find((p) => p.agency === route.agency_id) ?? parts[0];
  const name = own.name.split(/<BR>/i).at(-1).replace(/\s+/g, ' ').trim();
  const tidy = titleCase(name);
  return HK_RENAME[tidy] ?? tidy;
}

// Kuala Lumpur: Prasarana's Rapid Rail feed (LRT, MRT, monorail, BRT). Capacities are approximate full-train loads.
const KL_CAPACITY = { LRT: 800, MRT: 1200, MRL: 430, BRT: 90 };

export const CITIES = {
  'hong-kong': {
    region: 'HONG_KONG',
    out: 'db/data/hong-kong.json',
    source: 'Transport Department, DATA.GOV.HK (https://data.gov.hk/en-data/dataset/hk-td-tis_11-pt-headway-en)',
    licence: 'DATA.GOV.HK terms of use: free to use and redistribute with attribution',
    pick: (r) => HK_PICK[r.route_id] ?? null,
    // trip ids are "<route>-<direction 1|2>-<service>-<start>"
    direction: (t) => (t.trip_id.split('-')[1] === '2' ? '1' : '0'),
    stopName: hkStopName,
    fares: 'gtfs',
    regPrefix: (r, dir) => `HK-${HK_PICK[r.route_id].code}-${dir === '0' ? 'A' : 'B'}`,
  },
  'kuala-lumpur': {
    region: 'KUALA_LUMPUR',
    out: 'db/data/kuala-lumpur.json',
    source: 'Prasarana Malaysia via data.gov.my (https://developer.data.gov.my/realtime-api/gtfs-static), category rapid-rail-kl',
    licence: 'data.gov.my open data: free to use with attribution',
    pick: (r) =>
      r.status === 'valid' || !r.status
        ? { routeNo: r.route_short_name, line: r.route_long_name, mode: r.category === 'BRT' ? 'BUS' : 'TRAIN', capacity: KL_CAPACITY[r.category] ?? 800 }
        : null,
    direction: (t) => t.direction_id,
    stopName: (s) => titleCase(s.stop_name.replace(/\s+/g, ' ').trim()),
    fares: null, // the feed has no fares: the DISTANCE fare model estimates them
    regPrefix: (r, dir) => `KL-${r.route_short_name}-${dir === '0' ? 'A' : 'B'}`,
  },
};
