import crypto from 'node:crypto';

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { send, wrap } from '../../utils/async.js';
import { unauthorized } from '../../utils/errors.js';
import { ingestLocation, setOccupancy } from './service.js';

const router = Router();
const id = z.coerce.number().int().positive();

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

/** GPS devices authenticate with a shared key, not a user login. */
function requireDeviceKey(req, _res, next) {
  return safeEqual(req.headers['x-device-key'] ?? '', env.deviceApiKey) ? next() : next(unauthorized('Invalid device key.', 'INVALID_DEVICE_KEY'));
}

router.post(
  '/:id/location',
  requireDeviceKey,
  validate({
    params: z.object({ id }),
    body: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), recordedAt: z.coerce.date().optional() }),
  }),
  wrap(async (req, res) => {
    await ingestLocation(req.valid.params.id, req.valid.body);
    send(res, { ok: true }, 201);
  }),
);

router.post(
  '/:id/occupancy',
  requireAuth,
  requireRole('STAFF'),
  rateLimit({ windowMs: 60_000, limit: env.isTest ? 1000 : 120, standardHeaders: 'draft-7', legacyHeaders: false }),
  validate({ params: z.object({ id }), body: z.object({ passengerCount: z.number().int().min(0).max(5000) }) }),
  wrap(async (req, res) => send(res, await setOccupancy(req.valid.params.id, req.valid.body.passengerCount))),
);

export default router;
