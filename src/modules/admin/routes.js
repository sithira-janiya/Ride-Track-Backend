import { Router } from 'express';
import { z } from 'zod';

import { requireAdminOr, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { send, wrap } from '../../utils/async.js';
import { ADMIN_PASSWORD, EMAIL, NAME, PASSWORD, PHONE } from '../auth/schemas.js';
import {
  createUser,
  createVehicle,
  listRoutes,
  listTickets,
  listTrips,
  listUsers,
  listVehicles,
  overview,
  updateUser,
  updateVehicle,
} from './service.js';

const id = z.coerce.number().int().positive();
const page = z.coerce.number().int().min(1).default(1);
const limit = z.coerce.number().int().min(1).max(100).default(50);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.');
const employeeNo = z.string().trim().min(1).max(30);
const account = { name: NAME, email: EMAIL.optional(), phone: PHONE.optional(), password: PASSWORD };

/**
 * Back-office endpoints for the admin panel, mounted at /admin. Admins can use all of them;
 * authority officers can use the operations ones. Accounts (/users) are admins only.
 */
const router = Router();
router.use(requireAdminOr('AUTHORITY'));

router.get('/overview', wrap(async (_req, res) => send(res, await overview())));

// ---- accounts: admins only. Passengers sign themselves up; every other account is created here. ----

router.get(
  '/users',
  requireRole('ADMIN'),
  validate({
    query: z.object({
      q: z.string().trim().max(100).optional(),
      role: z.enum(['PASSENGER', 'STAFF', 'AUTHORITY', 'ADMIN']).optional(),
      page,
      limit,
    }),
  }),
  wrap(async (req, res) => send(res, await listUsers(req.valid.query))),
);

router.post(
  '/users',
  requireRole('ADMIN'),
  validate({
    body: z
      .discriminatedUnion('role', [
        z.object({
          ...account,
          role: z.literal('STAFF'),
          employeeNo,
          organisation: z.string().trim().min(2).max(100),
          staffType: z.enum(['CONDUCTOR', 'INSPECTOR']),
          vehicleId: id.optional(),
        }),
        z.object({ ...account, role: z.literal('AUTHORITY'), employeeNo, department: z.string().trim().min(2).max(100) }),
        // admins sign in by email only
        z.object({ ...account, role: z.literal('ADMIN'), email: EMAIL, password: ADMIN_PASSWORD }),
      ])
      .refine((v) => v.email || v.phone, { message: 'Provide an email address or a mobile number.', path: ['email'] }),
  }),
  wrap(async (req, res) => send(res, await createUser(req.valid.body), 201)),
);

router.patch(
  '/users/:id',
  requireRole('ADMIN'),
  validate({ params: z.object({ id }), body: z.object({ isActive: z.boolean().optional(), vehicleId: id.nullable().optional() }) }),
  wrap(async (req, res) => send(res, await updateUser(req.user.id, req.valid.params.id, req.valid.body))),
);

// ---- operations: admins and authority officers ----

router.get('/routes', wrap(async (_req, res) => send(res, await listRoutes())));

router.get('/vehicles', wrap(async (_req, res) => send(res, await listVehicles())));

router.post(
  '/vehicles',
  validate({
    body: z.object({
      regNo: z.string().trim().min(1).max(30),
      type: z.enum(['BUS', 'TRAIN']),
      capacity: z.number().int().min(1).max(5000),
      routeId: id,
    }),
  }),
  wrap(async (req, res) => send(res, await createVehicle(req.valid.body), 201)),
);

router.patch(
  '/vehicles/:id',
  validate({
    params: z.object({ id }),
    body: z
      .object({ regNo: z.string().trim().min(1).max(30), capacity: z.number().int().min(1).max(5000), routeId: id, isActive: z.boolean() })
      .partial(),
  }),
  wrap(async (req, res) => send(res, await updateVehicle(req.valid.params.id, req.valid.body))),
);

router.get(
  '/trips',
  validate({ query: z.object({ date: day, routeId: id.optional() }) }),
  wrap(async (req, res) => send(res, await listTrips(req.valid.query))),
);

router.get(
  '/tickets',
  validate({ query: z.object({ status: z.enum(['PENDING', 'ACTIVE', 'USED', 'EXPIRED', 'CANCELLED']).optional(), page, limit }) }),
  wrap(async (req, res) => send(res, await listTickets(req.valid.query))),
);

export default router;
