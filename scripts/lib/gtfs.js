// Helpers shared by the GTFS importers (scripts/import-gtfs.js, scripts/import-dubai-gtfs.js).
import { createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

export const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export const TURNAROUND_MIN = 5;

export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') cur += ch;
      else if (line[i + 1] === '"') (cur += '"'), (i += 1);
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') out.push(cur), (cur = '');
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const stripBom = (s) => s.replace(/^﻿/, '');

/** A whole (small) GTFS table as objects keyed by its header. */
export function readTable(dir, file) {
  const lines = stripBom(readFileSync(path.join(dir, file), 'utf8')).split(/\r?\n/).filter(Boolean);
  const head = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [head[i], v])));
}

/** Streams a big GTFS table (stop_times can have millions of rows), calling `onRow(row)` for every row. */
export async function streamTable(dir, file, onRow) {
  let head = null;
  for await (const line of createInterface({ input: createReadStream(path.join(dir, file)) })) {
    if (!line) continue;
    if (!head) {
      head = parseCsvLine(stripBom(line)).map((h) => h.trim());
      continue;
    }
    const f = parseCsvLine(line);
    onRow(Object.fromEntries(head.map((h, i) => [h, f[i]])));
  }
}

/** "25:10:00" -> seconds after midnight of the service day; '' -> null. */
export const seconds = (hms) => {
  if (!hms) return null;
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/** Fewest vehicles that can run every departure of one service day, with a short turnaround between trips. */
export function fleetNeeded(startsMin, durationMin) {
  const freeAt = [];
  for (const s of [...startsMin].sort((a, b) => a - b)) {
    const v = freeAt.findIndex((t) => t <= s);
    if (v < 0) freeAt.push(s + durationMin + TURNAROUND_MIN);
    else freeAt[v] = s + durationMin + TURNAROUND_MIN;
  }
  return freeAt.length;
}
