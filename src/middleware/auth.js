import jwt from 'jsonwebtoken';

import { query } from '../config/db.js';
import { env } from '../config/env.js';
import { wrap } from '../utils/async.js';
import { forbidden, unauthorized } from '../utils/errors.js';

/** Reads `Authorization: Bearer <accessToken>` and sets `req.user = { id, role }`. */
export function requireAuth(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized('Please log in.'));
  try {
    const payload = jwt.verify(token, env.jwtAccessSecret);
    req.user = { id: Number(payload.sub), role: payload.role };
    return next();
  } catch (e) {
    const expired = e?.name === 'TokenExpiredError';
    return next(unauthorized(expired ? 'Your session has expired.' : 'Please log in again.', expired ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED'));
  }
}

/** Allows only the listed roles. Use after `requireAuth`. */
export const requireRole =
  (...roles) =>
  (req, _res, next) =>
    roles.includes(req.user?.role) ? next() : next(forbidden('Your account type cannot do this.'));

/**
 * Admin-only routes. Besides an admin access token, the account is re-read on every request,
 * so a disabled admin loses access at once instead of when the token expires.
 */
export const requireAdmin = [
  requireAuth,
  requireRole('ADMIN'),
  wrap(async (req, _res, next) => {
    const [row] = await query('SELECT role, is_active FROM users WHERE user_id = ?', [req.user.id]);
    if (row?.role !== 'ADMIN' || !row.is_active) throw unauthorized('Please log in again.');
    next();
  }),
];

export function verifyAccessToken(token) {
  const payload = jwt.verify(token, env.jwtAccessSecret);
  return { id: Number(payload.sub), role: payload.role };
}
