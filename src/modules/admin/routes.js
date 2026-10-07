import { Router } from 'express';
import { z } from 'zod';

import { requireAdmin } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { send, wrap } from '../../utils/async.js';
import { ADMIN_PASSWORD, EMAIL, NAME, PASSWORD, PHONE } from '../auth/schemas.js';
import { createUser, listUsers, setActive } from './service.js';

const id = z.coerce.number().int().positive();
const employeeNo = z.string().trim().min(1).max(30);
const account = { name: NAME, email: EMAIL.optional(), phone: PHONE.optional(), password: PASSWORD };

/** Mounted at /admin/users. Passengers sign themselves up; every other account is created here. */
const router = Router();
router.use(requireAdmin);

router.get(
  '/',
  validate({
    query: z.object({
      role: z.enum(['PASSENGER', 'STAFF', 'AUTHORITY', 'ADMIN']).optional(),
      q: z.string().trim().max(100).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  }),
  wrap(async (req, res) => send(res, await listUsers(req.valid.query))),
);

router.post(
  '/',
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
  '/:id',
  validate({ params: z.object({ id }), body: z.object({ isActive: z.boolean() }) }),
  wrap(async (req, res) => send(res, await setActive(req.user.id, req.valid.params.id, req.valid.body.isActive))),
);

export default router;
