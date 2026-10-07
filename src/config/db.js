import mysql from 'mysql2/promise';

import { env } from './env.js';

/** One shared pool. DECIMAL columns come back as numbers; all dates are handled in UTC. */
export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  ssl: env.db.ssl ? { rejectUnauthorized: true } : undefined,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 20,
  enableKeepAlive: true,
  decimalNumbers: true,
  timezone: 'Z',
  namedPlaceholders: false,
});

/** Parameterised query helper: always pass values as the second argument, never build SQL from input. */
export async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** Runs `fn(conn)` inside a transaction; commits on success, rolls back on any error. */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
