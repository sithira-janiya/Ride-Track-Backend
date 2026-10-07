import { query, withTransaction } from '../../config/db.js';
import { emitOpsUpdate, emitToUser } from '../../realtime/index.js';
import { notFound } from '../../utils/errors.js';
import { sendPush } from './push.js';

const toAlert = (r, isRead) => ({
  alertId: r.alert_id,
  tripId: r.trip_id,
  type: r.type,
  message: r.message,
  delayMinutes: r.delay_minutes,
  createdAt: new Date(r.created_at).toISOString(),
  isRead: isRead ?? Boolean(r.is_read),
});

/**
 * Publishes an alert for a trip: stores it, tells every passenger holding a ticket for that trip (socket + push),
 * and updates the trip's status for cancellations and delays.
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
      await conn.query('INSERT INTO alert_recipients (alert_id, user_id) VALUES ?', [rows.map((r) => [a.insertId, r.user_id])]);
    }
    if (type === 'CANCELLATION') await conn.query("UPDATE trips SET status = 'CANCELLED' WHERE trip_id = ?", [tripId]);
    if (type === 'DELAY') await conn.query("UPDATE trips SET status = 'DELAYED' WHERE trip_id = ? AND status IN ('SCHEDULED','ONGOING')", [tripId]);
    return { alertId: a.insertId, recipients: rows.map((r) => r.user_id) };
  });

  const payload = { alertId, tripId, type, message, delayMinutes: delayMinutes ?? null };
  for (const userId of recipients) emitToUser(userId, 'alert:new', payload);
  emitOpsUpdate('alert');
  notifyDevices(recipients, message).catch((e) => console.warn('push failed:', e.message));

  const [row] = await query('SELECT * FROM delay_alerts WHERE alert_id = ?', [alertId]);
  return toAlert(row, false);
}

async function notifyDevices(userIds, body) {
  if (!userIds.length) return;
  const rows = await query('SELECT user_id, push_token FROM users WHERE user_id IN (?) AND push_token IS NOT NULL AND notifications_enabled = TRUE', [userIds]);
  const dead = await sendPush(rows.map((r) => r.push_token), { title: 'RideTrack alert', body });
  if (dead.length) await query('UPDATE users SET push_token = NULL WHERE push_token IN (?)', [dead]);
}

/** Passengers see the alerts addressed to them; officers see every alert that has been published. */
export async function listAlerts(user, { unread, limit }) {
  if (user.role === 'AUTHORITY') {
    const rows = await query('SELECT * FROM delay_alerts ORDER BY created_at DESC, alert_id DESC LIMIT ?', [limit]);
    return rows.map((r) => toAlert(r, true));
  }
  const rows = await query(
    `SELECT a.*, ar.is_read FROM delay_alerts a JOIN alert_recipients ar ON ar.alert_id = a.alert_id
      WHERE ar.user_id = ? ${unread ? 'AND ar.is_read = FALSE' : ''} ORDER BY a.created_at DESC, a.alert_id DESC LIMIT ?`,
    [user.id, limit],
  );
  return rows.map((r) => toAlert(r));
}

export async function markRead(userId, alertId) {
  const r = await query('UPDATE alert_recipients SET is_read = TRUE WHERE alert_id = ? AND user_id = ?', [alertId, userId]);
  if (!r.affectedRows) throw notFound('Alert not found.');
  const [row] = await query('SELECT a.*, ar.is_read FROM delay_alerts a JOIN alert_recipients ar ON ar.alert_id = a.alert_id WHERE a.alert_id = ? AND ar.user_id = ?', [alertId, userId]);
  return toAlert(row);
}
