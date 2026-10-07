import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { send, wrap } from '../../utils/async.js';
import { scanTicket, tripScans } from './service.js';

export const scansRouter = Router();

scansRouter.post(
  '/',
  requireAuth,
  requireRole('STAFF'),
  rateLimit({ windowMs: 60_000, limit: env.isTest ? 1000 : 120, standardHeaders: 'draft-7', legacyHeaders: false }),
  validate({
    body: z
      .object({ qrToken: z.string().min(10).max(600).optional(), ticketId: z.number().int().positive().optional() })
      .refine((v) => Boolean(v.qrToken) !== Boolean(v.ticketId), { message: 'Send either qrToken or ticketId.', path: ['qrToken'] }),
  }),
  wrap(async (req, res) => send(res, await scanTicket(req.user.id, req.valid.body))),
);

/** Mounted on /trips before the authority-only trips router. */
export const tripScansRouter = Router();

tripScansRouter.get(
  '/:id/scans',
  requireAuth,
  requireRole('STAFF', 'AUTHORITY'),
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  wrap(async (req, res) => send(res, await tripScans(req.valid.params.id))),
);
