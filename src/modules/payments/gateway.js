import crypto from 'node:crypto';

import { env } from '../../config/env.js';

/** HMAC-SHA256 hex, used both to sign webhook bodies and to protect the mock checkout link. */
export const sign = (value) => crypto.createHmac('sha256', env.paymentGatewayKey).update(value).digest('hex');

export function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Payment gateway interface: given a pending ticket, return the URL the passenger should open to pay.
 * The `mock` gateway serves its own checkout page (for development and demos). A real gateway such as
 * PayHere plugs in here: build its checkout URL/form and have it call POST /payments/webhook.
 */
export async function createPaymentSession({ ticketId }) {
  if (env.paymentGateway === 'mock') {
    return `${env.publicUrl}/api/v1/payments/mock/checkout/${ticketId}?sig=${sign(`checkout:${ticketId}`)}`;
  }
  throw new Error(`Payment gateway "${env.paymentGateway}" is not implemented yet.`);
}
