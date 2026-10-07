import { query, withTransaction } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/errors.js';
import { hashPassword, revokeSessions } from '../auth/service.js';
import { toUser } from '../users/service.js';

export async function listUsers({ role, q, page, limit }) {
  const where = [];
  const params = [];
  if (role) (where.push('role = ?'), params.push(role));
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push('(name LIKE ? OR email LIKE ? OR phone LIKE ?)');
    params.push(like, like, like);
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await query(`SELECT * FROM users ${filter} ORDER BY user_id DESC LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    (page - 1) * limit,
  ]);
  return rows.map(toUser);
}

/** Creates a STAFF, AUTHORITY or ADMIN account, with its staff or officer record, in one transaction. */
export async function createUser({ role, name, email, phone, password, employeeNo, organisation, staffType, vehicleId, department }) {
  const hash = await hashPassword(password);
  try {
    return await withTransaction(async (conn) => {
      const [result] = await conn.query('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)', [
        name,
        email ?? null,
        phone ?? null,
        hash,
        role,
      ]);
      const userId = result.insertId;
      if (role === 'STAFF') {
        await conn.query('INSERT INTO staff (user_id, employee_no, organisation, staff_type, vehicle_id) VALUES (?, ?, ?, ?, ?)', [
          userId,
          employeeNo,
          organisation,
          staffType,
          vehicleId ?? null,
        ]);
      } else if (role === 'AUTHORITY') {
        await conn.query('INSERT INTO authority_officers (user_id, department, employee_no) VALUES (?, ?, ?)', [userId, department, employeeNo]);
      }
      const [[row]] = await conn.query('SELECT * FROM users WHERE user_id = ?', [userId]);
      return toUser(row);
    });
  } catch (e) {
    if (e?.code === 'ER_DUP_ENTRY') throw conflict('An account with this email, phone or employee number already exists.', 'ACCOUNT_EXISTS');
    if (e?.code === 'ER_NO_REFERENCED_ROW_2') throw badRequest('That vehicle does not exist.');
    throw e;
  }
}

/** Disabling an account also ends its sessions. Admins cannot disable themselves, so the last admin cannot lock everyone out. */
export async function setActive(adminId, userId, isActive) {
  if (userId === adminId && !isActive) throw badRequest('You cannot disable your own account.', 'CANNOT_DISABLE_SELF');
  const result = await query('UPDATE users SET is_active = ? WHERE user_id = ?', [isActive, userId]);
  if (!result.affectedRows) throw notFound('Account not found.');
  if (!isActive) await revokeSessions(userId);
  const [row] = await query('SELECT * FROM users WHERE user_id = ?', [userId]);
  return toUser(row);
}
