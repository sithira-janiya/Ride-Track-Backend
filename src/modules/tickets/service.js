import { query, withTransaction } from '../../config/db.js';
import { badRequest, conflict, notFound } from '../../utils/errors.js';
import { getRouteStops } from '../routes/stops.js';
import { createPaymentSession } from '../payments/gateway.js';
import { signQrToken } from './qr.js';

const SELECT = `
  SELECT t.*, p.status AS payment_status, r.route_no, bs.name AS board_name, als.name AS alight_name
    FROM tickets t
    JOIN trips tr ON tr.trip_id = t.trip_id
    JOIN routes r ON r.route_id = tr.route_id
    JOIN stops bs ON bs.stop_id = t.board_stop_id
    JOIN stops als ON als.stop_id = t.alight_stop_id
    LEFT JOIN payments p ON p.ticket_id = t.ticket_id`;

/** Row -> the `Ticket` shape the app expects. The QR token only exists once the ticket is active (paid). */
export const toTicket = (r) => ({
  ticketId: r.ticket_id,
  tripId: r.trip_id,
  boardStopId: r.board_stop_id,
  alightStopId: r.alight_stop_id,
  fare: r.fare,
  status: r.status,
  qrToken: r.status === 'ACTIVE' ? r.qr_code : null,
  issuedAt: new Date(r.issued_at).toISOString(),
  paymentStatus: r.payment_status ?? undefined,
  routeNo: r.route_no,
  boardStopName: r.board_name,
  alightStopName: r.alight_name,
});

/** Creates a PENDING ticket (fare from the route's stop fares) and a payment session to pay it. */
export async function createTicket(userId, { tripId, boardStopId, alightStopId }) {
  const [trip] = await query('SELECT route_id, status FROM trips WHERE trip_id = ?', [tripId]);
  if (!trip) throw notFound('Trip not found.');
  if (!['SCHEDULED', 'ONGOING', 'DELAYED'].includes(trip.status)) throw conflict('This trip is no longer running.', 'TRIP_NOT_AVAILABLE');

  const stops = await getRouteStops(trip.route_id);
  const board = stops.find((s) => s.stopId === boardStopId);
  const alight = stops.find((s) => s.stopId === alightStopId);
  if (!board || !alight) throw badRequest('Both stops must be on this trip’s route.');
  if (alight.stopSequence <= board.stopSequence) throw badRequest('Choose a drop-off stop after your boarding stop.');
  const fare = Math.round((alight.fareFromOrigin - board.fareFromOrigin) * 100) / 100;

  const ticketId = await withTransaction(async (conn) => {
    const [t] = await conn.query('INSERT INTO tickets (user_id, trip_id, board_stop_id, alight_stop_id, fare) VALUES (?, ?, ?, ?, ?)', [
      userId, tripId, boardStopId, alightStopId, fare,
    ]);
    await conn.query('INSERT INTO payments (ticket_id, amount, method) VALUES (?, ?, ?)', [t.insertId, fare, 'GATEWAY']);
    return t.insertId;
  });
  return { ticketId, paymentUrl: await createPaymentSession({ ticketId, amount: fare }) };
}

export async function getTicket(userId, ticketId) {
  const [row] = await query(`${SELECT} WHERE t.ticket_id = ? AND t.user_id = ?`, [ticketId, userId]);
  if (!row) throw notFound('Ticket not found.');
  return toTicket(row);
}

export async function listTickets(userId, { status, page, limit }) {
  const where = ['t.user_id = ?'];
  const params = [userId];
  if (status) (where.push('t.status = ?'), params.push(status));
  const rows = await query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY t.issued_at DESC, t.ticket_id DESC LIMIT ? OFFSET ?`, [
    ...params, limit, (page - 1) * limit,
  ]);
  return rows.map(toTicket);
}

/** Cancels an unused ticket and refunds it. The status check and update are one statement, so a scan racing a cancel cannot both win. */
export async function cancelTicket(userId, ticketId) {
  const result = await withTransaction(async (conn) => {
    const [r] = await conn.query("UPDATE tickets SET status = 'CANCELLED' WHERE ticket_id = ? AND user_id = ? AND status = 'ACTIVE'", [ticketId, userId]);
    if (r.affectedRows) await conn.query("UPDATE payments SET status = 'REFUNDED' WHERE ticket_id = ? AND status = 'PAID'", [ticketId]);
    return r.affectedRows;
  });
  if (!result) {
    const [row] = await query('SELECT status FROM tickets WHERE ticket_id = ? AND user_id = ?', [ticketId, userId]);
    if (!row) throw notFound('Ticket not found.');
    if (row.status === 'USED') throw conflict('This ticket has already been used, so it cannot be cancelled.', 'TICKET_ALREADY_USED');
    throw conflict('Only an unused ticket can be cancelled.', 'TICKET_NOT_CANCELLABLE');
  }
  return getTicket(userId, ticketId);
}

/** Called inside the payment transaction: PENDING -> ACTIVE and attach the signed QR token. */
export async function activateTicket(conn, ticketId, tripId) {
  const [r] = await conn.query("UPDATE tickets SET status = 'ACTIVE', qr_code = ? WHERE ticket_id = ? AND status = 'PENDING'", [
    signQrToken(ticketId, tripId), ticketId,
  ]);
  return r.affectedRows === 1;
}
