// Applies db/schema.sql. Every statement is CREATE TABLE IF NOT EXISTS, so running it again is harmless.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import mysql from 'mysql2/promise';

import { env } from '../src/config/env.js';

/** Secondary indexes declared inside CREATE TABLE blocks: [{ table, name, columns, unique }]. */
export function declaredIndexes(sql) {
  const found = [];
  for (const [, table, body] of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
    for (const [, unique, name, columns] of body.matchAll(/^\s*(UNIQUE\s+)?(?:INDEX|KEY)\s+(\w+)\s*\(([^)]+)\)/gim)) {
      found.push({ table, name, columns, unique: Boolean(unique) });
    }
  }
  return found;
}

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
    // CREATE TABLE IF NOT EXISTS skips existing tables, so add any declared index they are missing
    const [existing] = await conn.query('SELECT DISTINCT table_name AS t, index_name AS i FROM information_schema.statistics WHERE table_schema = DATABASE()');
    const have = new Set(existing.map((r) => `${r.t}.${r.i}`.toLowerCase()));
    for (const ix of declaredIndexes(sql)) {
      if (have.has(`${ix.table}.${ix.name}`.toLowerCase())) continue;
      await conn.query(`ALTER TABLE ${ix.table} ADD ${ix.unique ? 'UNIQUE ' : ''}INDEX ${ix.name} (${ix.columns})`);
      console.log(`Added index ${ix.name} on ${ix.table}`);
    }
  } finally {
    await conn.end();
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('migrate.js')) {
  await migrate();
  console.log(`Schema applied to ${env.db.database} on ${env.db.host}:${env.db.port}`);
}
