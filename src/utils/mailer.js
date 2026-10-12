import { env } from '../config/env.js';

/** Messages "sent" while running tests, newest last, so tests can read the reset code. */
export const testOutbox = [];

/**
 * Sends a plain-text email through Resend's HTTP API (works on hosts that block outbound SMTP).
 * Without RESEND_API_KEY the message is logged in development and dropped in production.
 */
export async function sendMail({ to, subject, text }) {
  if (env.isTest) return void testOutbox.push({ to, subject, text });
  if (!env.resendApiKey) {
    if (env.isProd) console.warn('RESEND_API_KEY is not set: an email was not sent');
    else console.log(`[mail] to ${to}: ${subject}\n${text}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.resendApiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.mailFrom, to: [to], subject, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Email provider answered ${res.status}`);
}
