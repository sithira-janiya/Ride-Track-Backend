import { Router } from 'express';
import { z } from 'zod';

import { requireAdminOr } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { send, wrap } from '../../utils/async.js';
import { dashboard, generateReport } from './service.js';

export const opsRouter = Router();
opsRouter.use(requireAdminOr('AUTHORITY'));
opsRouter.get('/dashboard', wrap(async (_req, res) => send(res, await dashboard())));

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.');

export const reportsRouter = Router();
reportsRouter.use(requireAdminOr('AUTHORITY'));
reportsRouter.get(
  '/',
  validate({
    query: z.object({
      type: z.enum(['ROUTE_PERFORMANCE', 'DELAYS', 'OCCUPANCY']),
      routeId: z.coerce.number().int().positive().optional(),
      from: day,
      to: day,
    }),
  }),
  wrap(async (req, res) => send(res, await generateReport(req.user, req.valid.query))),
);
