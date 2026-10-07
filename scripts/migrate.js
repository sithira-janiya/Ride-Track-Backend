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

/** The quoted values in `'A','B'` or `enum('A','B')`. */
export const enumValues = (s) => s.match(/'[^']*'/g) ?? [];

/** ENUM columns declared inside CREATE TABLE blocks: [{ table, column, values, definition }]. */
export function declaredEnums(sql) {
  const found = [];
  for (const [, table, body] of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
    for (const [, column, definition, list] of body.matchAll(/^\s*(\w+)\s+(ENUM\(([^)]*)\)[^,\n]*)/gim)) {
      found.push({ table, column, values: enumValues(list), definition: `${column} ${definition.trim()}` });
    }
  }
  return found;
}

/** On a fresh deploy the database (or the platform's private DNS) can take a few seconds to come up, so retry the connect. */
async function connectWithRetry(options, attempts = Number(process.env.DB_CONNECT_RETRIES) || 10) {
  for (let i = 1; ; i++) {
    try {
      return await mysql.createConnection(options);
    } catch (e) {
      if (i >= attempts || e.code === 'ER_ACCESS_DENIED_ERROR' || e.code === 'ER_BAD_DB_ERROR') throw e;
      console.log(`Database not reachable yet (${e.code ?? e.message}), retrying in 3s (${i}/${attempts})`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

export async function migrate() {
  const sql = await readFile(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');
  const conn = await connectWithRetry(
    {
      host: env.db.host,
      port: env.db.port,
      user: env.db.user,
      password: env.db.password,
      database: env.db.database,
      ssl: env.db.ssl ? { rejectUnauthorized: true } : undefined,
      multipleStatements: true,
    },
    env.isTest ? 1 : undefined,
  );
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
    // and widen ENUM columns that gained values (e.g. users.role 'ADMIN'); never drop a value existing rows may hold
    const [columns] = await conn.query(
      "SELECT table_name AS t, column_name AS c, column_type AS type FROM information_schema.columns WHERE table_schema = DATABASE() AND data_type = 'enum'",
    );
    for (const col of declaredEnums(sql)) {
      const current = columns.find((r) => `${r.t}.${r.c}`.toLowerCase() === `${col.table}.${col.column}`.toLowerCase());
      if (!current) continue;
      const have = enumValues(current.type);
      if (col.values.every((v) => have.includes(v))) continue;
      if (have.some((v) => !col.values.includes(v))) {
        console.warn(`Skipped ${col.table}.${col.column}: the schema removes ENUM values rows may use. Change this column by hand.`);
        continue;
      }
      await conn.query(`ALTER TABLE ${col.table} MODIFY ${col.definition}`);
      console.log(`Added ENUM values to ${col.table}.${col.column}`);
    }
  } finally {
    await conn.end();
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('migrate.js')) {
  await migrate();
  console.log(`Schema applied to ${env.db.database} on ${env.db.host}:${env.db.port}`);
}
