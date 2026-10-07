import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { send, wrap } from '../../utils/async.js';
import { cancelTicket, createTicket, getTicket, listTickets } from './service.js';

const router = Router();
const id = z.coerce.number().int().positive();

router.use(requireAuth, requireRole('PASSENGER'));

router.post(
  '/',
  validate({ body: z.object({ tripId: id, boardStopId: id, alightStopId: id }) }),
  wrap(async (req, res) => send(res, await createTicket(req.user.id, req.valid.body), 201)),
);

router.get(
  '/',
  validate({
    query: z.object({
      status: z.enum(['PENDING', 'ACTIVE', 'USED', 'EXPIRED', 'CANCELLED']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
  }),
  wrap(async (req, res) => send(res, await listTickets(req.user.id, req.valid.query))),
);

router.get('/:id', validate({ params: z.object({ id }) }), wrap(async (req, res) => send(res, await getTicket(req.user.id, req.valid.params.id))));

router.post('/:id/cancel', validate({ params: z.object({ id }) }), wrap(async (req, res) => send(res, await cancelTicket(req.user.id, req.valid.params.id))));

export default router;
