// Applies db/schema.sql. Every statement is CREATE TABLE IF NOT EXISTS, so running it again is harmless.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import mysql from 'mysql2/promise';

import { env } from '../src/config/env.js';

export async function migrate() {
  const sql = await readFile(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    ssl: env.db.ssl ? { rejectUnauthorized: true } : undefined,
    multipleStatements: true,
  });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('migrate.js')) {
  await migrate();
  console.log(`Schema applied to ${env.db.database} on ${env.db.host}:${env.db.port}`);
}
