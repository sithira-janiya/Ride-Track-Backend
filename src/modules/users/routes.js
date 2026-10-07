import { Router } from 'express';
import { z } from 'zod';

import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { send, wrap } from '../../utils/async.js';
import { getUser, setPushToken, updateUser } from './service.js';

const router = Router();
router.use(requireAuth);

router.get('/me', wrap(async (req, res) => send(res, await getUser(req.user.id))));

router.patch(
  '/me',
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(100).optional(),
      language: z.enum(['en', 'si', 'ta']).optional(),
      notificationsEnabled: z.boolean().optional(),
    }),
  }),
  wrap(async (req, res) => send(res, await updateUser(req.user.id, req.valid.body))),
);

router.put(
  '/me/push-token',
  validate({ body: z.object({ token: z.string().trim().min(10).max(512) }) }),
  wrap(async (req, res) => {
    await setPushToken(req.user.id, req.valid.body.token);
    send(res, { ok: true });
  }),
);

export default router;
