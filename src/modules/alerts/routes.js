import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { send, wrap } from '../../utils/async.js';
import { listAlerts, markRead, publishAlert } from './service.js';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  requireRole('PASSENGER', 'AUTHORITY'),
  validate({
    query: z.object({
      unread: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  }),
  wrap(async (req, res) => send(res, await listAlerts(req.user, req.valid.query))),
);

router.patch(
  '/:id/read',
  requireRole('PASSENGER'),
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  wrap(async (req, res) => send(res, await markRead(req.user.id, req.valid.params.id))),
);

router.post(
  '/',
  requireRole('AUTHORITY'),
  validate({
    body: z.object({
      tripId: z.number().int().positive(),
      type: z.enum(['DELAY', 'CANCELLATION', 'ROUTE_CHANGE']),
      message: z.string().trim().min(5).max(255),
      delayMinutes: z.number().int().min(1).max(600).optional(),
    }),
  }),
  wrap(async (req, res) => send(res, await publishAlert(req.valid.body), 201)),
);

export default router;
