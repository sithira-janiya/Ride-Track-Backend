import http from 'node:http';

import { createApp } from './app.js';
import { pool } from './config/db.js';
import { env } from './config/env.js';
import { startJobs } from './jobs/index.js';
import { loadLatestPositions } from './modules/vehicles/positions.js';
import { closeRealtime, initRealtime } from './realtime/index.js';

const server = http.createServer(createApp());
initRealtime(server);

await pool.query('SELECT 1'); // fail fast if the database is unreachable
await loadLatestPositions();
const stopJobs = env.enableJobs ? startJobs() : () => {};

server.listen(env.port, () => console.log(`RideTrack API listening on :${env.port} (${env.nodeEnv}, jobs ${env.enableJobs ? 'on' : 'off'})`));

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, shutting down`);
  stopJobs();
  closeRealtime();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
