import { isDuplicateKey, limit, query, withTransaction } from '../../config/db.js';
import { regionInfo } from '../../config/regions.js';
import { badRequest, conflict, notFound } from '../../utils/errors.js';
import { hashPassword, revokeSessions } from '../auth/service.js';
import { toRoute } from '../routes/service.js';
import { toUser } from '../users/service.js';

// '!' escapes LIKE wildcards the same way in MySQL and SQL Server (a backslash does not)
const like = (q) => `%${q.replace(/[%_![]/g, (c) => `!${c}`)}%`;
const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Headline numbers for the admin overview. */
export async function overview() {
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const [[users], [fleet], [trips], sales] = await Promise.all([
    query(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN role = 'PASSENGER' THEN 1 ELSE 0 END) AS passengers,
              SUM(CASE WHEN role = 'STAFF' THEN 1 ELSE 0 END) AS staff, SUM(CASE WHEN role = 'AUTHORITY' THEN 1 ELSE 0 END) AS officers,
              SUM(CASE WHEN role = 'ADMIN' THEN 1 ELSE 0 END) AS admins,
              SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS disabled
         FROM users`,
    ),
    query(
      `SELECT (SELECT COUNT(*) FROM routes WHERE is_active = 1) AS routes,
              (SELECT COUNT(*) FROM vehicles WHERE is_active = 1) AS vehicles,
              (SELECT COUNT(*) FROM stops) AS stops`,
    ),
    query(
      // DELAYED is a reserved word in MySQL, so it cannot be a bare column alias
      `SELECT COUNT(*) AS today, SUM(CASE WHEN status = 'ONGOING' THEN 1 ELSE 0 END) AS ongoing,
              SUM(CASE WHEN status = 'DELAYED' THEN 1 ELSE 0 END) AS delayed_trips, SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled
         FROM trips WHERE start_time >= ? AND start_time < ?`,
      [today, new Date(today.getTime() + 86400000)],
    ),
    query(
      `SELECT r.region, COUNT(*) AS tickets, COALESCE(SUM(p.amount), 0) AS revenue
         FROM payments p JOIN tickets k ON k.ticket_id = p.ticket_id JOIN trips t ON t.trip_id = k.trip_id JOIN routes r ON r.route_id = t.route_id
        WHERE p.status = 'PAID' AND p.paid_at >= ?
        GROUP BY r.region ORDER BY r.region DESC`,
      [today],
    ),
  ]);
  const n = (v) => Number(v ?? 0);
  return {
    users: { total: n(users.total), passengers: n(users.passengers), staff: n(users.staff), officers: n(users.officers), admins: n(users.admins), disabled: n(users.disabled) },
    fleet: { routes: n(fleet.routes), vehicles: n(fleet.vehicles), stops: n(fleet.stops) },
    tripsToday: { total: n(trips.today), ongoing: n(trips.ongoing), delayed: n(trips.delayed_trips), cancelled: n(trips.cancelled) },
    // revenue adds every currency together and is kept for older clients; byCurrency is the one to show
    salesToday: {
      tickets: sales.reduce((sum, s) => sum + n(s.tickets), 0),
      revenue: sales.reduce((sum, s) => sum + n(s.revenue), 0),
      byCurrency: sales.map((s) => ({ currency: regionInfo(s.region).currency, tickets: n(s.tickets), revenue: n(s.revenue) })),
    },
  };
}

// ---- users ----

export async function listUsers({ q, role, page, limit: perPage }) {
  const where = [];
  const params = [];
  if (role) (where.push('u.role = ?'), params.push(role));
  if (q) (where.push("(u.name LIKE ? ESCAPE '!' OR u.email LIKE ? ESCAPE '!' OR u.phone LIKE ? ESCAPE '!')"), params.push(like(q), like(q), like(q)));
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, [{ total }]] = await Promise.all([
    query(
      `SELECT u.*, COALESCE(s.employee_no, a.employee_no) AS employee_no, COALESCE(s.organisation, a.department) AS organisation,
              s.staff_type, s.vehicle_id
         FROM users u LEFT JOIN staff s ON s.user_id = u.user_id LEFT JOIN authority_officers a ON a.user_id = u.user_id
         ${sql} ORDER BY u.user_id DESC ${limit(perPage, (page - 1) * perPage)}`,
      params,
    ),
    query(`SELECT COUNT(*) AS total FROM users u ${sql}`, params),
  ]);
  return {
    total: Number(total),
    users: rows.map((r) => ({
      ...toUser(r),
      createdAt: iso(r.created_at),
      employeeNo: r.employee_no ?? null,
      organisation: r.organisation ?? null,
      staffType: r.staff_type ?? null,
      vehicleId: r.vehicle_id ?? null,
    })),
  };
}

/** Creates a STAFF, AUTHORITY or ADMIN account, with its staff or officer record, in one transaction. Passengers sign themselves up. */
export async function createUser({ name, email, phone, password, role, employeeNo, organisation, staffType, vehicleId, department }) {
  const hash = await hashPassword(password);
  try {
    const userId = await withTransaction(async (conn) => {
      if (vehicleId) {
        const [[v]] = await conn.query('SELECT vehicle_id FROM vehicles WHERE vehicle_id = ?', [vehicleId]);
        if (!v) throw badRequest('That vehicle does not exist.');
      }
      const [r] = await conn.query('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)', [
        name, email ?? null, phone ?? null, hash, role,
      ]);
      if (role === 'STAFF') {
        await conn.query('INSERT INTO staff (user_id, employee_no, organisation, staff_type, vehicle_id) VALUES (?, ?, ?, ?, ?)', [
          r.insertId, employeeNo, organisation, staffType, vehicleId ?? null,
        ]);
      } else if (role === 'AUTHORITY') {
        await conn.query('INSERT INTO authority_officers (user_id, department, employee_no) VALUES (?, ?, ?)', [r.insertId, department, employeeNo]);
      }
      return r.insertId;
    });
    const [row] = await query('SELECT * FROM users WHERE user_id = ?', [userId]);
    return toUser(row);
  } catch (e) {
    if (isDuplicateKey(e)) throw conflict('An account with this email, phone or employee number already exists.', 'ACCOUNT_EXISTS');
    throw e;
  }
}

/**
 * Enables/disables an account, or reassigns a staff member's vehicle. Disabling also ends the account's sessions.
 * Admins cannot disable themselves, so the last admin cannot lock everyone out.
 */
export async function updateUser(actorId, userId, { isActive, vehicleId }) {
  const [row] = await query('SELECT * FROM users WHERE user_id = ?', [userId]);
  if (!row) throw notFound('Account not found.');
  if (isActive === false && userId === actorId) throw badRequest('You cannot disable your own account.', 'CANNOT_DISABLE_SELF');
  if (vehicleId !== undefined) {
    if (row.role !== 'STAFF') throw badRequest('Only staff can be assigned to a vehicle.');
    if (vehicleId !== null) {
      const [v] = await query('SELECT vehicle_id FROM vehicles WHERE vehicle_id = ?', [vehicleId]);
      if (!v) throw notFound('Vehicle not found.');
    }
    await query('UPDATE staff SET vehicle_id = ? WHERE user_id = ?', [vehicleId, userId]);
  }
  if (isActive !== undefined) {
    await query('UPDATE users SET is_active = ? WHERE user_id = ?', [isActive, userId]);
    if (!isActive) await revokeSessions(userId);
  }
  const [updated] = await query('SELECT * FROM users WHERE user_id = ?', [userId]);
  return toUser(updated);
}

// ---- routes, vehicles, trips, tickets ----

/** Every route, including inactive ones, with stop and vehicle counts. */
export async function listRoutes() {
  const rows = await query(
    `SELECT r.*, (SELECT COUNT(*) FROM route_stops rs WHERE rs.route_id = r.route_id) AS stops,
            (SELECT COUNT(*) FROM vehicles v WHERE v.route_id = r.route_id AND v.is_active = 1) AS vehicles
       FROM routes r ORDER BY r.region DESC, r.mode, r.route_no, r.route_id`,
  );
  return rows.map((r) => ({
    ...toRoute(r),
    isActive: Boolean(r.is_active),
    stops: Number(r.stops),
    vehicles: Number(r.vehicles),
  }));
}

const toVehicle = (v) => ({
  vehicleId: v.vehicle_id,
  regNo: v.reg_no,
  type: v.type,
  capacity: v.capacity,
  routeId: v.route_id,
  routeNo: v.route_no,
  isActive: Boolean(v.is_active),
});

export async function listVehicles() {
  const rows = await query('SELECT v.*, r.route_no FROM vehicles v JOIN routes r ON r.route_id = v.route_id ORDER BY v.vehicle_id');
  return rows.map(toVehicle);
}

async function getVehicle(vehicleId) {
  const [v] = await query('SELECT v.*, r.route_no FROM vehicles v JOIN routes r ON r.route_id = v.route_id WHERE v.vehicle_id = ?', [vehicleId]);
  if (!v) throw notFound('Vehicle not found.');
  return toVehicle(v);
}

async function checkRoute(routeId, type) {
  const [r] = await query('SELECT mode FROM routes WHERE route_id = ?', [routeId]);
  if (!r) throw notFound('Route not found.');
  if (type && r.mode !== type) throw badRequest(`A ${type.toLowerCase()} cannot run on a ${r.mode.toLowerCase()} route.`);
}

export async function createVehicle({ regNo, type, capacity, routeId }) {
  await checkRoute(routeId, type);
  try {
    const r = await query('INSERT INTO vehicles (reg_no, type, capacity, route_id) VALUES (?, ?, ?, ?)', [regNo, type, capacity, routeId]);
    return getVehicle(r.insertId);
  } catch (e) {
    if (isDuplicateKey(e)) throw conflict('A vehicle with this registration number already exists.');
    throw e;
  }
}

export async function updateVehicle(vehicleId, { regNo, capacity, routeId, isActive }) {
  const current = await getVehicle(vehicleId);
  if (routeId !== undefined) await checkRoute(routeId, current.type);
  const sets = [];
  const params = [];
  if (regNo !== undefined) (sets.push('reg_no = ?'), params.push(regNo));
  if (capacity !== undefined) (sets.push('capacity = ?'), params.push(capacity));
  if (routeId !== undefined) (sets.push('route_id = ?'), params.push(routeId));
  if (isActive !== undefined) (sets.push('is_active = ?'), params.push(isActive));
  try {
    if (sets.length) await query(`UPDATE vehicles SET ${sets.join(', ')} WHERE vehicle_id = ?`, [...params, vehicleId]);
  } catch (e) {
    if (isDuplicateKey(e)) throw conflict('A vehicle with this registration number already exists.');
    throw e;
  }
  return getVehicle(vehicleId);
}

/** Trips starting on the given UTC day, optionally for one route. `timeZone` is the route's, for showing local times. */
export async function listTrips({ date, routeId }) {
  const dayStart = new Date(`${date}T00:00:00Z`);
  const rows = await query(
    `SELECT t.*, r.route_no, r.region, v.reg_no,
            (SELECT COUNT(*) FROM tickets k WHERE k.trip_id = t.trip_id AND k.status IN ('ACTIVE','USED')) AS tickets
       FROM trips t JOIN routes r ON r.route_id = t.route_id JOIN vehicles v ON v.vehicle_id = t.vehicle_id
      WHERE t.start_time >= ? AND t.start_time < ? ${routeId ? 'AND t.route_id = ?' : ''}
      ORDER BY t.start_time, t.trip_id ${limit(500)}`,
    [dayStart, new Date(dayStart.getTime() + 86400000), ...(routeId ? [routeId] : [])],
  );
  return rows.map((t) => ({
    tripId: t.trip_id,
    routeId: t.route_id,
    routeNo: t.route_no,
    vehicleId: t.vehicle_id,
    regNo: t.reg_no,
    startTime: iso(t.start_time),
    endTime: iso(t.end_time),
    timeZone: regionInfo(t.region).timeZone,
    status: t.status,
    tickets: Number(t.tickets),
  }));
}

export async function listTickets({ status, page, limit: perPage }) {
  const filter = status ? 'WHERE k.status = ?' : '';
  const params = status ? [status] : [];
  const [rows, [{ total }]] = await Promise.all([
    query(
      `SELECT k.*, u.name AS passenger, r.route_no, r.region, p.status AS payment_status, p.method
         FROM tickets k JOIN users u ON u.user_id = k.user_id JOIN trips t ON t.trip_id = k.trip_id
         JOIN routes r ON r.route_id = t.route_id LEFT JOIN payments p ON p.ticket_id = k.ticket_id
        ${filter}
        ORDER BY k.ticket_id DESC ${limit(perPage, (page - 1) * perPage)}`,
      params,
    ),
    query(`SELECT COUNT(*) AS total FROM tickets k ${filter}`, params),
  ]);
  const tickets = rows.map((k) => ({
    ticketId: k.ticket_id,
    passenger: k.passenger,
    tripId: k.trip_id,
    routeNo: k.route_no,
    fare: k.fare,
    currency: regionInfo(k.region).currency,
    status: k.status,
    paymentStatus: k.payment_status ?? null,
    paymentMethod: k.method ?? null,
    issuedAt: iso(k.issued_at),
  }));
  return { total: Number(total), tickets };
}
