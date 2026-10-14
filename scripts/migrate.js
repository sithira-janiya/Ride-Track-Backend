// Applies db/schema.sql. Every statement is CREATE TABLE IF NOT EXISTS, so running it again is harmless. Tables that
// already exist get any column or index the schema has gained since, and lose the indexes listed in REPLACED_INDEXES.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import mysql from 'mysql2/promise';

import { loadMssql, mssqlConfig } from '../src/config/db.js';
import { env } from '../src/config/env.js';

/** Indexes the schema used to declare, dropped from existing tables: [table, index]. */
const REPLACED_INDEXES = [['routes', 'uq_route']];

const NOT_A_COLUMN = /^(PRIMARY|UNIQUE|INDEX|KEY|FOREIGN|CONSTRAINT|CHECK)\b/i;

/** Columns declared inside CREATE TABLE blocks, in order: [{ table, name, definition, after }]. */
export function declaredColumns(sql) {
  const found = [];
  for (const [, table, body] of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
    let after = null;
    for (const line of body.split('\n').map((l) => l.trim().replace(/,$/, '')).filter(Boolean)) {
      const name = line.match(/^(\w+)\s/)?.[1];
      if (!name || NOT_A_COLUMN.test(line)) continue;
      found.push({ table, name, definition: line, after });
      after = name;
    }
  }
  return found;
}

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

/** SQL Server: creates the database when missing, then runs db/schema.mssql.sql batch by batch (split on GO lines). */
async function migrateMssql() {
  const sql = await loadMssql();
  const name = env.db.database;
  if (!/^\w+$/.test(name)) throw new Error(`DB_NAME "${name}" may only contain letters, digits and underscores`);

  const connect = async (database, attempts = env.isTest ? 1 : Number(process.env.DB_CONNECT_RETRIES) || 10) => {
    for (let i = 1; ; i++) {
      try {
        return await new sql.ConnectionPool(mssqlConfig(database)).connect();
      } catch (e) {
        if (i >= attempts || e.code === 'ELOGIN') throw e;
        console.log(`Database not reachable yet (${e.code ?? e.message}), retrying in 3s (${i}/${attempts})`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };

  // Azure SQL and locked-down servers do not let the app login into master; there the database must already exist
  const master = await connect('master').catch(() => null);
  if (master) {
    try {
      await master.request().input('name', sql.NVarChar, name).query(`IF DB_ID(@name) IS NULL EXEC('CREATE DATABASE [${name}]')`);
    } finally {
      await master.close();
    }
  }

  const schema = await readFile(fileURLToPath(new URL('../db/schema.mssql.sql', import.meta.url)), 'utf8');
  const pool = await connect(name);
  try {
    for (const batch of schema.split(/^\s*GO\s*$/im).map((b) => b.trim()).filter((b) => b.replace(/--.*$/gm, '').trim())) {
      await pool.request().batch(batch);
    }
  } finally {
    await pool.close();
  }
}

export async function migrate() {
  if (env.db.client === 'mssql') return migrateMssql();
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
    // CREATE TABLE IF NOT EXISTS skips existing tables, so add any declared column and index they are missing
    const [columns] = await conn.query('SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE()');
    const haveColumn = new Set(columns.map((r) => `${r.t}.${r.c}`.toLowerCase()));
    for (const col of declaredColumns(sql)) {
      if (haveColumn.has(`${col.table}.${col.name}`.toLowerCase())) continue;
      await conn.query(`ALTER TABLE ${col.table} ADD COLUMN ${col.definition}${col.after ? ` AFTER ${col.after}` : ' FIRST'}`);
      console.log(`Added column ${col.name} to ${col.table}`);
    }
    const [existing] = await conn.query('SELECT DISTINCT table_name AS t, index_name AS i FROM information_schema.statistics WHERE table_schema = DATABASE()');
    const have = new Set(existing.map((r) => `${r.t}.${r.i}`.toLowerCase()));
    for (const ix of declaredIndexes(sql)) {
      if (have.has(`${ix.table}.${ix.name}`.toLowerCase())) continue;
      await conn.query(`ALTER TABLE ${ix.table} ADD ${ix.unique ? 'UNIQUE ' : ''}INDEX ${ix.name} (${ix.columns})`);
      console.log(`Added index ${ix.name} on ${ix.table}`);
    }
    for (const [table, name] of REPLACED_INDEXES) {
      if (!have.has(`${table}.${name}`.toLowerCase())) continue;
      await conn.query(`ALTER TABLE ${table} DROP INDEX ${name}`);
      console.log(`Dropped index ${name} on ${table}`);
    }
    // and widen ENUM columns that gained values (e.g. users.role 'ADMIN'); never drop a value existing rows may hold
    const [enumColumns] = await conn.query(
      "SELECT table_name AS t, column_name AS c, column_type AS type FROM information_schema.columns WHERE table_schema = DATABASE() AND data_type = 'enum'",
    );
    for (const col of declaredEnums(sql)) {
      const current = enumColumns.find((r) => `${r.t}.${r.c}`.toLowerCase() === `${col.table}.${col.column}`.toLowerCase());
      if (!current) continue;
      const existingValues = enumValues(current.type);
      if (col.values.every((v) => existingValues.includes(v))) continue;
      if (existingValues.some((v) => !col.values.includes(v))) {
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

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('migrate.js')) {
  await migrate();
  const where = env.db.client === 'mssql' && env.db.instance ? `${env.db.host}\\${env.db.instance}` : `${env.db.host}:${env.db.port}`;
  console.log(`Schema applied to ${env.db.database} on ${where} (${env.db.client})`);
}
