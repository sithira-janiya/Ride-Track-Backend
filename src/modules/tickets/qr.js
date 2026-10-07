import jwt from 'jsonwebtoken';

import { env } from '../../config/env.js';

/**
 * The QR carries a signed token bound to one ticket and its trip. A screenshot of someone else's ticket still
 * validates only once, because the server marks the ticket USED; a forged or edited code fails the signature.
 */
export const signQrToken = (ticketId, tripId) => jwt.sign({ tid: ticketId, trip: tripId }, env.qrSigningSecret, { algorithm: 'HS256' });

/** Returns `{ tid, trip }`, or null when the token is not one of ours. */
export function verifyQrToken(token) {
  try {
    const p = jwt.verify(token, env.qrSigningSecret, { algorithms: ['HS256'] });
    return Number.isInteger(p.tid) && Number.isInteger(p.trip) ? { tid: p.tid, trip: p.trip } : null;
  } catch {
    return null;
  }
}
