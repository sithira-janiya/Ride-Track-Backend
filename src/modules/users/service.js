import { query } from '../../config/db.js';
import { notFound } from '../../utils/errors.js';

/** Row -> the `User` shape the mobile app expects. Never includes the password hash or push token. */
export const toUser = (r) => ({
  userId: r.user_id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  role: r.role,
  language: r.language,
  notificationsEnabled: Boolean(r.notifications_enabled),
  isActive: Boolean(r.is_active),
});

export async function getUser(userId) {
  const [row] = await query('SELECT * FROM users WHERE user_id = ? AND is_active = TRUE', [userId]);
  if (!row) throw notFound('Account not found.');
  return toUser(row);
}

export async function updateUser(userId, { name, language, notificationsEnabled }) {
  const sets = [];
  const params = [];
  if (name !== undefined) (sets.push('name = ?'), params.push(name));
  if (language !== undefined) (sets.push('language = ?'), params.push(language));
  if (notificationsEnabled !== undefined) (sets.push('notifications_enabled = ?'), params.push(notificationsEnabled));
  if (sets.length) await query(`UPDATE users SET ${sets.join(', ')} WHERE user_id = ?`, [...params, userId]);
  return getUser(userId);
}

export async function setPushToken(userId, token) {
  await query('UPDATE users SET push_token = ? WHERE user_id = ?', [token, userId]);
}
