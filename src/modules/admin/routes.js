import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { send, wrap } from '../../utils/async.js';
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

/** Back-office endpoints for the admin panel. Authority officers only. */
const router = Router();
router.use(requireAuth, requireRole('AUTHORITY'));

router.get('/overview', wrap(async (_req, res) => send(res, await overview())));

router.get(
  '/users',
  validate({
    query: z.object({
      q: z.string().trim().max(100).optional(),
      role: z.enum(['PASSENGER', 'STAFF', 'AUTHORITY']).optional(),
      page,
      limit,
    }),
  }),
  wrap(async (req, res) => send(res, await listUsers(req.valid.query))),
);

router.post(
  '/users',
  validate({
    body: z
      .object({
        name: z.string().trim().min(2).max(100),
        email: z.string().trim().toLowerCase().email().max(150).optional(),
        phone: z
          .string()
          .trim()
          .transform((v) => v.replace(/[\s-]/g, ''))
          .refine((v) => /^\+?\d{9,15}$/.test(v), 'Enter a valid mobile number.')
          .optional(),
        password: z
          .string()
          .min(8, 'Use at least 8 characters.')
          .max(128)
          .regex(/[A-Za-z]/, 'Include at least one letter.')
          .regex(/\d/, 'Include at least one number.'),
        role: z.enum(['STAFF', 'AUTHORITY']),
        employeeNo: z.string().trim().min(1).max(30),
        organisation: z.string().trim().min(1).max(100),
        staffType: z.enum(['CONDUCTOR', 'INSPECTOR']).optional(),
        vehicleId: id.optional(),
      })
      .refine((v) => v.email || v.phone, { message: 'Provide an email address or a mobile number.', path: ['email'] }),
  }),
  wrap(async (req, res) => send(res, await createUser(req.valid.body), 201)),
);

router.patch(
  '/users/:id',
  validate({ params: z.object({ id }), body: z.object({ isActive: z.boolean().optional(), vehicleId: id.nullable().optional() }) }),
  wrap(async (req, res) => send(res, await updateUser(req.user.id, req.valid.params.id, req.valid.body))),
);

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
