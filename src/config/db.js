// One database API for MySQL and Microsoft SQL Server (DB_CLIENT=mysql|mssql). Services write `?` placeholders and
// portable SQL; the few things the two dialects spell differently (row limits, row locks, bulk inserts) go through the
// helpers below. Results have the same shape on both: SELECT gives an array of rows, INSERT gives { insertId,
// affectedRows }, UPDATE and DELETE give { affectedRows }.
import { env } from './env.js';

export const isMssql = env.db.client === 'mssql';

const POOL_SIZE = Number(process.env.DB_POOL_SIZE) || 20;

/** `LIMIT n OFFSET m` in either dialect. SQL Server needs an ORDER BY before it. Values are checked integers, so inlining them is safe. */
export function limit(n, offset = 0) {
  const [rows, skip] = [Number(n), Number(offset)];
  if (!Number.isInteger(rows) || !Number.isInteger(skip) || rows < 0 || skip < 0) throw new TypeError('limit and offset must be non-negative integers');
  return isMssql ? `OFFSET ${skip} ROWS FETCH NEXT ${rows} ROWS ONLY` : `LIMIT ${rows} OFFSET ${skip}`;
}

/**
 * Row locks for a SELECT inside a transaction: put `lock` right after the table name and `forUpdate` at the very end,
 * e.g. `SELECT * FROM payments${lock} WHERE ticket_id = ?${forUpdate}`.
 */
export const lock = isMssql ? ' WITH (UPDLOCK, ROWLOCK)' : '';
export const forUpdate = isMssql ? '' : ' FOR UPDATE';

/** True when a write failed on a UNIQUE or PRIMARY KEY constraint. */
export const isDuplicateKey = (e) => (isMssql ? [2627, 2601].includes(errorNumber(e)) : e?.code === 'ER_DUP_ENTRY');

/** True when a write referenced a row that does not exist (foreign key). */
export const isMissingReference = (e) => (isMssql ? errorNumber(e) === 547 : e?.code === 'ER_NO_REFERENCED_ROW_2');

/** SQL Server error number. The msnodesqlv8 driver sometimes reports only "EREQUEST", so fall back to the message. */
function errorNumber(e) {
  const found = [e?.number, e?.originalError?.number, e?.originalError?.info?.number, e?.originalError?.code].find(Number.isInteger);
  if (found !== undefined) return found;
  const message = String(e?.message ?? '');
  if (/Cannot insert duplicate key|Violation of (UNIQUE KEY|PRIMARY KEY) constraint/i.test(message)) return 2627;
  if (/conflicted with the FOREIGN KEY constraint/i.test(message)) return 547;
  return undefined;
}

// ---------------------------------------------------------------- MySQL

async function createMysql() {
  const { default: mysql } = await import('mysql2/promise');
  const pool = mysql.createPool({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    ssl: env.db.ssl ? { rejectUnauthorized: true } : undefined,
    waitForConnections: true,
    connectionLimit: POOL_SIZE,
    enableKeepAlive: true,
    decimalNumbers: true,
    timezone: 'Z',
    namedPlaceholders: false,
  });
  // TIMESTAMP columns and CURRENT_TIMESTAMP follow the session time zone; keep it UTC like everything else
  pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));

  return {
    query: async (sql, params) => (await pool.query(sql, params))[0],
    async transaction(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const result = await fn({ query: (sql, params = []) => conn.query(sql, params) });
        await conn.commit();
        return result;
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    },
    end: () => pool.end(),
  };
}

// ---------------------------------------------------------------- SQL Server

/** Connection settings for the `mssql` package: SQL logins via tedious, or Windows authentication via msnodesqlv8. */
export function mssqlConfig(database = env.db.database) {
  const { host, port, instance, user, password, ssl, trustedConnection, trustServerCertificate } = env.db;
  const pool = { max: POOL_SIZE, min: 0, idleTimeoutMillis: 30_000 };
  if (trustedConnection) {
    const server = instance ? `${host}\\${instance}` : `${host},${port}`;
    const driver = process.env.DB_ODBC_DRIVER ?? 'ODBC Driver 18 for SQL Server';
    return {
      connectionString: `Driver={${driver}};Server=${server};Database=${database};Trusted_Connection=yes;Encrypt=${ssl ? 'yes' : 'optional'};TrustServerCertificate=${trustServerCertificate ? 'yes' : 'no'};`,
      options: { useUTC: true },
      pool,
    };
  }
  return {
    server: host,
    ...(instance ? {} : { port }),
    user,
    password,
    database,
    pool,
    options: { instanceName: instance || undefined, encrypt: ssl, trustServerCertificate, useUTC: true, enableArithAbort: true },
  };
}

export async function loadMssql() {
  const mod = env.db.trustedConnection ? await import('mssql/msnodesqlv8.js') : await import('mssql');
  return mod.default ?? mod;
}

/**
 * `?` placeholders -> @arg0, @arg1 ... (not @p1: the ODBC driver names its own parameters @P1, @P2 ...). An array value
 * expands to a list, for `IN (?)`. Question marks inside quotes are left alone.
 */
function toNamed(text, params, sql) {
  const inputs = [];
  const add = (value) => {
    const name = `arg${inputs.length}`;
    inputs.push([name, value]);
    return `@${name}`;
  };
  let out = '';
  let quote = null;
  let i = 0;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '?') {
      const value = params[i++];
      out += Array.isArray(value) ? (value.length ? value.map(add).join(', ') : 'NULL') : add(value);
      continue;
    }
    out += ch;
  }
  return { text: out, inputs: inputs.map(([name, value]) => [name, typeOf(value, sql), value]) };
}

function typeOf(value, sql) {
  if (value instanceof Date) return sql.DateTime2(3);
  if (typeof value === 'boolean') return sql.Bit;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return sql.Float;
    return Math.abs(value) <= 2147483647 ? sql.Int : sql.BigInt;
  }
  if (Buffer.isBuffer(value)) return sql.VarBinary(sql.MAX);
  return sql.NVarChar(sql.MAX);
}

async function createMssql() {
  const sql = await loadMssql();
  const pool = new sql.ConnectionPool(mssqlConfig());
  let connecting = null;
  const ready = () => {
    connecting ??= pool.connect().catch((e) => {
      connecting = null; // try again on the next query
      throw e;
    });
    return connecting;
  };

  async function run(executor, text, params = []) {
    const { text: statement, inputs } = toNamed(text, params, sql);
    const request = executor.request();
    for (const [name, type, value] of inputs) request.input(name, type, value);
    const isInsert = /^\s*INSERT\b/i.test(statement);
    const res = await request.query(isInsert ? `${statement};\nSELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS insertId` : statement);
    if (isInsert) {
      const id = res.recordset?.[0]?.insertId;
      return { insertId: id == null ? null : Number(id), affectedRows: res.rowsAffected[0] ?? 0 };
    }
    if (res.recordset) return res.recordset;
    return { affectedRows: res.rowsAffected.reduce((a, b) => a + b, 0) };
  }

  return {
    query: async (text, params) => run(await ready(), text, params),
    async transaction(fn) {
      const tx = new sql.Transaction(await ready());
      await tx.begin();
      try {
        const result = await fn({ query: async (text, params) => [await run(tx, text, params)] });
        await tx.commit();
        return result;
      } catch (e) {
        await tx.rollback().catch(() => {}); // SQL Server may already have rolled back after some errors
        throw e;
      }
    },
    end: () => pool.close(),
  };
}

// ---------------------------------------------------------------- shared API

const db = isMssql ? await createMssql() : await createMysql();

/** Parameterised query helper: always pass values as the second argument, never build SQL from input. */
export const query = (sql, params = []) => db.query(sql, params);

/** Runs `fn(conn)` inside a transaction; commits on success, rolls back on any error. `conn.query` resolves to `[result]`. */
export const withTransaction = (fn) => db.transaction(fn);

/** Inserts many rows with as few statements as each database allows. `conn` is optional (inside a transaction). */
export async function insertMany(table, columns, rows, conn = null) {
  // SQL Server takes at most 1000 rows per VALUES list and 2100 parameters per statement
  const perStatement = isMssql ? Math.min(1000, Math.floor(2000 / columns.length)) : 1000;
  const tuple = `(${columns.map(() => '?').join(', ')})`;
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => tuple).join(', ')}`;
    if (conn) await conn.query(sql, chunk.flat());
    else await query(sql, chunk.flat());
  }
}

/** Cheap connectivity check (used by /health and on start). */
export const ping = () => query('SELECT 1 AS ok');

export const closePool = () => db.end();
