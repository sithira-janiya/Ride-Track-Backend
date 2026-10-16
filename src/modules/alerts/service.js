import { insertMany, limit as limitRows, query, withTransaction } from '../../config/db.js';
import { emitOpsUpdate, emitToUser } from '../../realtime/index.js';
import { notFound } from '../../utils/errors.js';
import { translate, translateMany } from '../../utils/translate.js';
import { sendPush } from './push.js';

const toAlert = (r, isRead) => ({
  alertId: r.alert_id,
  tripId: r.trip_id,
  type: r.type,
  message: r.translated_message ?? r.message,
  originalMessage: r.message,
  delayMinutes: r.delay_minutes,
  createdAt: new Date(r.created_at).toISOString(),
  isRead: isRead ?? Boolean(r.is_read),
});

/**
 * Publishes an alert for a trip: stores it, tells every passenger holding a ticket for that trip (socket + push)
 * in their own language, and updates the trip's status for cancellations and delays.
 */
export async function publishAlert({ tripId, type, message, delayMinutes }) {
  const [trip] = await query('SELECT trip_id, status FROM trips WHERE trip_id = ?', [tripId]);
  if (!trip) throw notFound('Trip not found.');

  const { alertId, recipients } = await withTransaction(async (conn) => {
    const [a] = await conn.query('INSERT INTO delay_alerts (trip_id, type, message, delay_minutes) VALUES (?, ?, ?, ?)', [
      tripId, type, message, delayMinutes ?? null,
    ]);
    const [rows] = await conn.query("SELECT DISTINCT user_id FROM tickets WHERE trip_id = ? AND status IN ('PENDING','ACTIVE')", [tripId]);
    if (rows.length) {
      await insertMany('alert_recipients', ['alert_id', 'user_id'], rows.map((r) => [a.insertId, r.user_id]), conn);
    }
    if (type === 'CANCELLATION') await conn.query("UPDATE trips SET status = 'CANCELLED' WHERE trip_id = ?", [tripId]);
    if (type === 'DELAY') await conn.query("UPDATE trips SET status = 'DELAYED' WHERE trip_id = ? AND status IN ('SCHEDULED','ONGOING')", [tripId]);
    return { alertId: a.insertId, recipients: rows.map((r) => r.user_id) };
  });

  emitOpsUpdate('alert');
  deliver(recipients, { alertId, tripId, type, message, delayMinutes: delayMinutes ?? null }).catch((e) => console.warn('alert delivery failed:', e.message));

  const [row] = await query('SELECT * FROM delay_alerts WHERE alert_id = ?', [alertId]);
  return toAlert(row, false);
}

/** Sends the alert to each recipient (socket + push), translated once per language. */
async function deliver(userIds, alert) {
  if (!userIds.length) return;
  const users = await query('SELECT user_id, language, push_token, notifications_enabled FROM users WHERE user_id IN (?)', [userIds]);
  const byLanguage = new Map();
  for (const u of users) byLanguage.set(u.language, [...(byLanguage.get(u.language) ?? []), u]);
  const dead = [];
  await Promise.all(
    [...byLanguage].map(async ([language, group]) => {
      const message = await translate(alert.message, language);
      const payload = { ...alert, message, originalMessage: alert.message };
      for (const u of group) emitToUser(u.user_id, 'alert:new', payload);
      const tokens = group.filter((u) => u.push_token && u.notifications_enabled).map((u) => u.push_token);
      dead.push(...(await sendPush(tokens, { title: 'RideTrack alert', body: message })));
    }),
  );
  if (dead.length) await query('UPDATE users SET push_token = NULL WHERE push_token IN (?)', [dead]);
}

/** Adds `translated_message` to alert rows, in the passenger's language. */
async function localize(userId, rows) {
  if (!rows.length) return rows;
  const [user] = await query('SELECT language FROM users WHERE user_id = ?', [userId]);
  const translated = await translateMany(rows.map((r) => r.message), user?.language);
  return rows.map((r, i) => ({ ...r, translated_message: translated[i] }));
}

/** Passengers see the alerts addressed to them; officers and admins see every alert that has been published. */
export async function listAlerts(user, { unread, limit }) {
  if (user.role === 'AUTHORITY' || user.role === 'ADMIN') {
    const rows = await query(`SELECT * FROM delay_alerts ORDER BY created_at DESC, alert_id DESC ${limitRows(limit)}`);
    return rows.map((r) => toAlert(r, true));
  }
  const rows = await query(
    `SELECT a.*, ar.is_read FROM delay_alerts a JOIN alert_recipients ar ON ar.alert_id = a.alert_id
      WHERE ar.user_id = ? ${unread ? 'AND ar.is_read = 0' : ''} ORDER BY a.created_at DESC, a.alert_id DESC ${limitRows(limit)}`,
    [user.id],
  );
  return (await localize(user.id, rows)).map((r) => toAlert(r));
}

export async function markRead(userId, alertId) {
  const r = await query('UPDATE alert_recipients SET is_read = 1 WHERE alert_id = ? AND user_id = ?', [alertId, userId]);
  if (!r.affectedRows) throw notFound('Alert not found.');
  const [row] = await query('SELECT a.*, ar.is_read FROM delay_alerts a JOIN alert_recipients ar ON ar.alert_id = a.alert_id WHERE a.alert_id = ? AND ar.user_id = ?', [alertId, userId]);
  const [localized] = await localize(userId, [row]);
  return toAlert(localized);
}
