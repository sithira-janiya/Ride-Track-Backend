import { env } from '../../config/env.js';

let messaging = null;
let tried = false;

/** Lazily sets up Firebase Cloud Messaging. Stays disabled (and logs once) when no service account is configured. */
async function getMessaging() {
  if (tried) return messaging;
  tried = true;
  if (!env.fcmServiceAccount) return null;
  try {
    // firebase-admin is optional: install it only on deployments that send push (`npm i firebase-admin`)
    const admin = (await import('firebase-admin')).default;
    const { readFile } = await import('node:fs/promises');
    const cred = JSON.parse(await readFile(env.fcmServiceAccount, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(cred) });
    messaging = admin.messaging();
  } catch (e) {
    console.warn('Push notifications disabled:', e.message);
  }
  return messaging;
}

/** Sends one push to many device tokens. Returns the tokens FCM says are dead so the caller can clear them. */
export async function sendPush(tokens, { title, body }) {
  if (!tokens.length) return [];
  const m = await getMessaging();
  if (!m) return [];
  const res = await m.sendEachForMulticast({ tokens, notification: { title, body }, android: { priority: 'high' } });
  return res.responses
    .map((r, i) => (!r.success && /registration-token-not-registered|invalid-argument/.test(r.error?.code ?? '') ? tokens[i] : null))
    .filter(Boolean);
}
