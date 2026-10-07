import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { validate } from '../../middleware/validate.js';
import { send, wrap } from '../../utils/async.js';
import { login, refresh, register } from './service.js';

const router = Router();

// brute-force protection on the credential endpoints (NFR3)
router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.isTest ? 1000 : 50,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' } },
  }),
);

const EMAIL = z.string().trim().toLowerCase().email().max(150);
const PHONE = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^\+?\d{9,15}$/.test(v), 'Enter a valid mobile number.');
const PASSWORD = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(128)
  .regex(/[A-Za-z]/, 'Include at least one letter.')
  .regex(/\d/, 'Include at least one number.');

router.post(
  '/register',
  validate({
    body: z
      .object({ name: z.string().trim().min(2).max(100), email: EMAIL.optional(), phone: PHONE.optional(), password: PASSWORD })
      .refine((v) => v.email || v.phone, { message: 'Provide an email address or a mobile number.', path: ['email'] }),
  }),
  wrap(async (req, res) => send(res, await register(req.valid.body), 201)),
);

router.post(
  '/login',
  validate({ body: z.object({ identifier: z.string().trim().min(1).max(150), password: z.string().min(1).max(128) }) }),
  wrap(async (req, res) => {
    // emails are stored lower-case; phones have separators removed
    const raw = req.valid.body.identifier;
    const identifier = raw.includes('@') ? raw.toLowerCase() : raw.replace(/[\s-]/g, '');
    send(res, await login({ identifier, password: req.valid.body.password }));
  }),
);

router.post(
  '/refresh',
  validate({ body: z.object({ refreshToken: z.string().min(20).max(200) }) }),
  wrap(async (req, res) => send(res, await refresh(req.valid.body.refreshToken))),
);

export default router;
