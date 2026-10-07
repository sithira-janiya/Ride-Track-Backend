import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { validate } from '../../middleware/validate.js';
import { send, wrap } from '../../utils/async.js';
import { EMAIL, NAME, PASSWORD, PHONE } from './schemas.js';
import { adminLogin, login, logout, refresh, register } from './service.js';

// brute-force protection on the credential endpoints (NFR3)
const credentialLimit = (limit) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.isTest ? 1000 : limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please wait a few minutes and try again.' } },
  });

const REFRESH_BODY = z.object({ refreshToken: z.string().min(20).max(200) });

const router = Router();
router.use(credentialLimit(50));

router.post(
  '/register',
  validate({
    body: z
      .object({ name: NAME, email: EMAIL.optional(), phone: PHONE.optional(), password: PASSWORD })
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
  validate({ body: REFRESH_BODY }),
  wrap(async (req, res) => send(res, await refresh(req.valid.body.refreshToken))),
);

export default router;

/** Admin sign-in, kept apart from the app sign-in: email only, a tighter rate limit and shorter sessions (ADMIN_REFRESH_TTL_HOURS). */
export const adminAuthRouter = Router();
adminAuthRouter.use(credentialLimit(20));

adminAuthRouter.post(
  '/login',
  validate({ body: z.object({ email: EMAIL, password: z.string().min(1).max(128) }) }),
  wrap(async (req, res) => send(res, await adminLogin(req.valid.body))),
);

adminAuthRouter.post(
  '/refresh',
  validate({ body: REFRESH_BODY }),
  wrap(async (req, res) => send(res, await refresh(req.valid.body.refreshToken, { admin: true }))),
);

adminAuthRouter.post(
  '/logout',
  validate({ body: REFRESH_BODY }),
  wrap(async (req, res) => {
    await logout(req.valid.body.refreshToken);
    send(res, { ok: true });
  }),
);
