import { z } from 'zod';

// Account fields shared by sign-up, admin-created accounts and scripts/create-admin.js.

export const EMAIL = z.string().trim().toLowerCase().email().max(150);

export const PHONE = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^\+?\d{9,15}$/.test(v), 'Enter a valid mobile number.');

export const PASSWORD = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(128)
  .regex(/[A-Za-z]/, 'Include at least one letter.')
  .regex(/\d/, 'Include at least one number.');

/** An admin password unlocks every account, so it must be longer. */
export const ADMIN_PASSWORD = PASSWORD.min(12, 'Admin passwords need at least 12 characters.');

export const NAME = z.string().trim().min(2).max(100);
