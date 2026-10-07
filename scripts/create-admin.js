// Creates an admin account, or resets an existing admin's password. Nobody can sign up as an admin through the API,
// so the first admin comes from here; after that, admins can add more with POST /api/v1/admin/users.
//   npm run create-admin -- --email you@example.com [--name "Your Name"]
// The password comes from ADMIN_PASSWORD, or is generated and printed once. Never pass it as an argument: it would stay in shell history.
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

import { pool, query } from '../src/config/db.js';
import { ADMIN_PASSWORD, EMAIL, NAME } from '../src/modules/auth/schemas.js';
import { hashPassword, revokeSessions } from '../src/modules/auth/service.js';

function parse(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${label}: ${result.error.issues[0].message}`);
  return result.data;
}

/** Returns `{ created }`: true for a new admin, false when an existing admin's password was reset (which also ends its sessions). */
export async function createAdmin({ email, name = 'Administrator', password }) {
  email = parse(EMAIL, email, 'email');
  name = parse(NAME, name, 'name');
  password = parse(ADMIN_PASSWORD, password, 'password');
  const hash = await hashPassword(password);

  const [existing] = await query('SELECT user_id, role FROM users WHERE email = ?', [email]);
  if (existing && existing.role !== 'ADMIN') throw new Error(`${email} already has an account (role ${existing.role}). Use another email for the admin.`);
  if (existing) {
    await query('UPDATE users SET password_hash = ?, is_active = TRUE WHERE user_id = ?', [hash, existing.user_id]);
    await revokeSessions(existing.user_id);
    return { created: false };
  }
  await query("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'ADMIN')", [name, email, hash]);
  return { created: true };
}

/** 24 random characters that meet the admin password rules. */
function generatePassword() {
  for (;;) {
    const candidate = crypto.randomBytes(18).toString('base64url');
    if (ADMIN_PASSWORD.safeParse(candidate).success) return candidate;
  }
}

if (process.argv[1]?.endsWith('create-admin.js')) {
  try {
    const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
    if (!values.email) throw new Error('Pass the admin email: npm run create-admin -- --email you@example.com');
    const password = process.env.ADMIN_PASSWORD || generatePassword();
    const { created } = await createAdmin({ email: values.email, name: values.name, password });
    console.log(created ? `Created admin ${values.email}.` : `Reset the password of admin ${values.email} and signed it out everywhere.`);
    if (!process.env.ADMIN_PASSWORD) console.log(`Password (shown once, keep it in a password manager): ${password}`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
