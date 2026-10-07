import { withTransaction } from '../../config/db.js';
import { notFound } from '../../utils/errors.js';
import { activateTicket } from '../tickets/service.js';

/**
 * Applies a gateway payment result. Safe to call more than once for the same payment (gateways retry):
 * the payment row is locked, and a payment that is no longer PENDING is left alone.
 * Returns the resulting payment status.
 */
export async function applyPaymentResult({ ticketId, gatewayRef, status }) {
  return withTransaction(async (conn) => {
    const [[payment]] = await conn.query('SELECT * FROM payments WHERE ticket_id = ? FOR UPDATE', [ticketId]);
    if (!payment) throw notFound('Payment not found.');
    if (payment.status !== 'PENDING') return payment.status; // duplicate webhook

    const [[ticket]] = await conn.query('SELECT trip_id, status FROM tickets WHERE ticket_id = ? FOR UPDATE', [ticketId]);

    if (status === 'FAILED') {
      await conn.query("UPDATE payments SET status = 'FAILED', gateway_ref = ? WHERE payment_id = ?", [gatewayRef ?? null, payment.payment_id]);
      await conn.query("UPDATE tickets SET status = 'CANCELLED' WHERE ticket_id = ? AND status = 'PENDING'", [ticketId]);
      return 'FAILED';
    }

    // paid, but the ticket was cancelled or expired while the passenger was at the gateway: money must go back
    if (ticket.status !== 'PENDING') {
      await conn.query("UPDATE payments SET status = 'REFUNDED', gateway_ref = ?, paid_at = UTC_TIMESTAMP() WHERE payment_id = ?", [gatewayRef ?? null, payment.payment_id]);
      return 'REFUNDED';
    }

    await conn.query("UPDATE payments SET status = 'PAID', gateway_ref = ?, paid_at = UTC_TIMESTAMP() WHERE payment_id = ?", [gatewayRef ?? null, payment.payment_id]);
    await activateTicket(conn, ticketId, ticket.trip_id);
    return 'PAID';
  });
}
