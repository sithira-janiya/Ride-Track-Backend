import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import { forUpdate, isDuplicateKey, limit, lock, query, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError, badRequest, conflict, unauthorized } from '../../utils/errors.js';
import { sendMail, testOutbox } from '../../utils/mailer.js';
import { toUser } from '../users/service.js';

const BCRYPT_ROUNDS = 10;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const signAccess = (user) => jwt.sign({ role: user.role }, env.jwtAccessSecret, { subject: String(user.user_id), expiresIn: env.accessTtl });

/** Creates a refresh token, stores only its hash, and returns the raw value to the client once. */
async function issueRefresh(userId, conn = null) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const expires = new Date(Date.now() + env.jwtRefreshTtlDays * 86400000);
  const sql = 'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)';
  if (conn) await conn.query(sql, [userId, sha256(raw), expires]);
  else await query(sql, [userId, sha256(raw), expires]);
  return raw;
}

async function authResult(row) {
  return { user: toUser(row), accessToken: signAccess(row), refreshToken: await issueRefresh(row.user_id) };
}

/** Public sign-up always creates a PASSENGER. Staff and officers are created by an administrator (see scripts/seed.js). */
export async function register({ name, email, phone, password }) {
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    const result = await query('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)', [
      name,
      email ?? null,
      phone ?? null,
      hash,
      'PASSENGER',
    ]);
    const [row] = await query('SELECT * FROM users WHERE user_id = ?', [result.insertId]);
    return authResult(row);
  } catch (e) {
    if (isDuplicateKey(e)) throw conflict('An account with these details already exists.', 'ACCOUNT_EXISTS');
    throw e;
  }
}

// A real hash to compare against when the account does not exist, so response time does not reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

export async function login({ identifier, password }) {
  const isEmail = identifier.includes('@');
  const [row] = await query(`SELECT * FROM users WHERE ${isEmail ? 'email' : 'phone'} = ?`, [identifier]);
  const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
  // one message for unknown account, wrong password and disabled account
  if (!row || !ok || !row.is_active) throw unauthorized('Invalid email/phone or password.', 'INVALID_CREDENTIALS');
  return authResult(row);
}

const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/**
 * Checks a Google ID token with Google's tokeninfo endpoint (which verifies the signature and expiry)
 * and that it was issued to one of our OAuth clients. Returns the token's claims.
 */
async function verifyGoogleIdToken(idToken) {
  if (env.googleClientIds.length === 0) throw new AppError(503, 'GOOGLE_DISABLED', 'Google sign-in is not available right now.');
  let res;
  try {
    res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new AppError(503, 'GOOGLE_UNAVAILABLE', 'Cannot reach Google right now. Please try again.');
  }
  const claims = res.ok ? await res.json() : null;
  if (
    !claims ||
    !env.googleClientIds.includes(claims.aud) ||
    !GOOGLE_ISSUERS.includes(claims.iss) ||
    Number(claims.exp) * 1000 < Date.now() ||
    !claims.email ||
    String(claims.email_verified) !== 'true'
  ) {
    throw unauthorized('Google sign-in failed. Please try again.', 'GOOGLE_TOKEN_INVALID');
  }
  return claims;
}

/**
 * Signs in with Google. A verified Google email that matches an existing account logs into it;
 * otherwise a new PASSENGER is created. Google-only accounts get an unusable random password.
 */
export async function googleLogin(idToken) {
  const claims = await verifyGoogleIdToken(idToken);
  const email = claims.email.toLowerCase();
  const findUser = async () => (await query('SELECT * FROM users WHERE email = ?', [email]))[0];

  let row = await findUser();
  if (!row) {
    const name = (claims.name || email.split('@')[0]).trim().slice(0, 100);
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), BCRYPT_ROUNDS);
    try {
      await query('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, NULL, ?, ?)', [name, email, hash, 'PASSENGER']);
    } catch (e) {
      // a parallel sign-in created it first
      if (!isDuplicateKey(e)) throw e;
    }
    row = await findUser();
  }
  if (!row?.is_active) throw unauthorized('This account is disabled.', 'ACCOUNT_DISABLED');
  return authResult(row);
}

/** Rotates the refresh token: the old one is revoked and a new pair is returned. Re-using a revoked token fails. */
export async function refresh(rawToken) {
  const hash = sha256(rawToken);
  return withTransaction(async (conn) => {
    const [[tokenRow]] = await conn.query(`SELECT * FROM refresh_tokens${lock} WHERE token_hash = ?${forUpdate}`, [hash]);
    if (!tokenRow || tokenRow.revoked || new Date(tokenRow.expires_at) < new Date()) {
      throw unauthorized('Your session has expired. Please log in again.', 'REFRESH_INVALID');
    }
    const [[user]] = await conn.query('SELECT * FROM users WHERE user_id = ? AND is_active = 1', [tokenRow.user_id]);
    if (!user) throw unauthorized('Your session has expired. Please log in again.', 'REFRESH_INVALID');
    await conn.query('UPDATE refresh_tokens SET revoked = 1 WHERE token_id = ?', [tokenRow.token_id]);
    return { accessToken: signAccess(user), refreshToken: await issueRefresh(user.user_id, conn) };
  });
}

const RESET_TTL_MINUTES = 15;
const RESET_MAX_ATTEMPTS = 5;
const RESET_RESEND_SECONDS = 60;
// keyed so a leaked table cannot be checked against all 10^6 codes offline
const hashResetCode = (userId, code) => crypto.createHmac('sha256', env.jwtAccessSecret).update(`reset:${userId}:${code}`).digest('hex');

const findByIdentifier = async (identifier) =>
  (await query(`SELECT * FROM users WHERE ${identifier.includes('@') ? 'email' : 'phone'} = ?`, [identifier]))[0];

async function deliverResetCode(user, code) {
  const text = `Your RideTrack password reset code is ${code}. It expires in ${RESET_TTL_MINUTES} minutes.

If you did not ask to reset your password, you can ignore this message.`;
  if (user.email) return sendMail({ to: user.email, subject: 'Your RideTrack password reset code', text });
  // no SMS provider yet: phone-only accounts can see their code in development logs only
  if (env.isTest) testOutbox.push({ to: user.phone, subject: 'sms', text });
  else if (!env.isProd) console.log(`[sms] to ${user.phone}: ${text}`);
  else console.warn(`No SMS provider configured: password reset code for user ${user.user_id} was not sent`);
}

/**
 * Sends a 6-digit reset code to the account's email (or phone). Always resolves the same way, whether or not the
 * account exists, and delivers in the background so response time does not reveal it either.
 */
export async function forgotPassword(identifier) {
  const user = await findByIdentifier(identifier);
  if (!user?.is_active) return;
  const [recent] = await query('SELECT 1 AS hit FROM password_resets WHERE user_id = ? AND created_at > ?', [
    user.user_id,
    new Date(Date.now() - RESET_RESEND_SECONDS * 1000),
  ]);
  if (recent) return;
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await withTransaction(async (conn) => {
    // only the newest code works
    await conn.query('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', [user.user_id]);
    await conn.query('INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES (?, ?, ?)', [
      user.user_id,
      hashResetCode(user.user_id, code),
      new Date(Date.now() + RESET_TTL_MINUTES * 60000),
    ]);
  });
  const delivery = deliverResetCode(user, code).catch((e) => console.error(`Password reset delivery failed: ${e.message}`));
  if (env.isTest) await delivery;
}

/** Checks the reset code, sets the new password, signs out every other session and signs the user in. */
export async function resetPassword({ identifier, code, password }) {
  const invalid = () => badRequest('That code is wrong or has expired. Request a new one.', 'RESET_CODE_INVALID');
  const user = await findByIdentifier(identifier);
  if (!user?.is_active) throw invalid();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const ok = await withTransaction(async (conn) => {
    const [[reset]] = await conn.query(
      `SELECT * FROM password_resets${lock} WHERE user_id = ? AND used = 0 AND expires_at > ? ORDER BY reset_id DESC ${limit(1)}${forUpdate}`,
      [user.user_id, new Date()],
    );
    if (!reset || reset.attempts >= RESET_MAX_ATTEMPTS) return false;
    const expected = Buffer.from(reset.code_hash, 'hex');
    if (!crypto.timingSafeEqual(expected, Buffer.from(hashResetCode(user.user_id, code), 'hex'))) {
      await conn.query('UPDATE password_resets SET attempts = attempts + 1 WHERE reset_id = ?', [reset.reset_id]);
      return false;
    }
    await conn.query('UPDATE password_resets SET used = 1 WHERE reset_id = ?', [reset.reset_id]);
    await conn.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, user.user_id]);
    await conn.query('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0', [user.user_id]);
    return true;
  });
  if (!ok) throw invalid();
  return authResult(user);
}
