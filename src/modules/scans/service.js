import { query } from '../../config/db.js';
import { forbidden, notFound } from '../../utils/errors.js';
import { verifyQrToken } from '../tickets/qr.js';

const INVALID = (code, reason) => ({ result: 'INVALID', code, reason });

async function record(staffId, ticketId, result) {
  await query('INSERT INTO ticket_scans (ticket_id, staff_id, result) VALUES (?, ?, ?)', [ticketId, staffId, result]);
}

/**
 * Validates a ticket for a conductor or inspector. Always writes a `ticket_scans` row (even for unknown codes).
 * A valid ticket is marked USED with a single conditional UPDATE, so two phones scanning the same code at the
 * same moment cannot both be told VALID.
 */
export async function scanTicket(staffId, { qrToken, ticketId: manualId }) {
  const [staff] = await query('SELECT user_id FROM staff WHERE user_id = ?', [staffId]);
  if (!staff) throw forbidden('Your account has no conductor or inspector profile.', 'STAFF_PROFILE_MISSING');

  let ticketId = manualId ?? null;
  if (qrToken) {
    const decoded = verifyQrToken(qrToken);
    if (!decoded) {
      await record(staffId, null, 'INVALID');
      return INVALID('INVALID_QR', 'This is not a RideTrack ticket.');
    }
    ticketId = decoded.tid;
  }

  const [ticket] = await query(
    `SELECT t.ticket_id, t.status, t.qr_code, t.trip_id, tr.status AS trip_status
       FROM tickets t JOIN trips tr ON tr.trip_id = t.trip_id WHERE t.ticket_id = ?`,
    [ticketId],
  );
  // a QR is only good for the exact token we issued: an old or edited token for the same ticket id fails
  if (!ticket || (qrToken && ticket.qr_code !== qrToken)) {
    await record(staffId, ticket?.ticket_id ?? null, 'INVALID');
    return INVALID('TICKET_NOT_FOUND', 'Ticket not found. This is not a valid RideTrack ticket.');
  }

  const bad = {
    PENDING: ['TICKET_NOT_PAID', 'Payment has not been completed.'],
    USED: ['TICKET_ALREADY_USED', 'This ticket has already been scanned.'],
    EXPIRED: ['TICKET_EXPIRED', 'This ticket has expired.'],
    CANCELLED: ['TICKET_CANCELLED', 'This ticket was cancelled.'],
  }[ticket.status];
  if (bad) {
    await record(staffId, ticket.ticket_id, 'INVALID');
    return INVALID(...bad);
  }
  if (['CANCELLED', 'COMPLETED'].includes(ticket.trip_status)) {
    await record(staffId, ticket.ticket_id, 'INVALID');
    return INVALID('TICKET_EXPIRED', ticket.trip_status === 'CANCELLED' ? 'This trip was cancelled.' : 'This trip has already finished.');
  }

  const r = await query("UPDATE tickets SET status = 'USED' WHERE ticket_id = ? AND status = 'ACTIVE'", [ticket.ticket_id]);
  if (!r.affectedRows) {
    await record(staffId, ticket.ticket_id, 'INVALID');
    return INVALID('TICKET_ALREADY_USED', 'This ticket has already been scanned.');
  }
  await record(staffId, ticket.ticket_id, qrToken ? 'VALID' : 'MANUAL_ID');
  return { result: 'VALID', ticketId: ticket.ticket_id, tripId: ticket.trip_id };
}

export async function tripScans(tripId) {
  const [trip] = await query('SELECT trip_id FROM trips WHERE trip_id = ?', [tripId]);
  if (!trip) throw notFound('Trip not found.');
  const rows = await query(
    `SELECT s.scan_id, s.ticket_id, s.staff_id, s.result, s.scanned_at
       FROM ticket_scans s LEFT JOIN tickets t ON t.ticket_id = s.ticket_id
      WHERE t.trip_id = ? ORDER BY s.scanned_at DESC, s.scan_id DESC LIMIT 500`,
    [tripId],
  );
  return rows.map((r) => ({ scanId: r.scan_id, ticketId: r.ticket_id, staffId: r.staff_id, result: r.result, scannedAt: new Date(r.scanned_at).toISOString() }));
}
