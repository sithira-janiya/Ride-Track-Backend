import crypto from 'node:crypto';

import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { pool } from './config/db.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import adminUsersRouter from './modules/admin/routes.js';
import alertsRouter from './modules/alerts/routes.js';
import authRouter, { adminAuthRouter } from './modules/auth/routes.js';
import downloadsRouter from './modules/downloads/routes.js';
import { opsRouter, reportsRouter } from './modules/ops/routes.js';
import paymentsRouter from './modules/payments/routes.js';
import { routesRouter, stopsRouter, tripsRouter } from './modules/routes/routes.js';
import { scansRouter, tripScansRouter } from './modules/scans/routes.js';
import ticketsRouter from './modules/tickets/routes.js';
import usersRouter from './modules/users/routes.js';
import vehiclesRouter from './modules/vehicles/routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind a platform load balancer; needed for correct client IPs in rate limiting

  app.use((req, res, next) => {
    req.id = crypto.randomUUID().slice(0, 8);
    res.setHeader('x-request-id', req.id);
    next();
  });
  if (!env.isTest) {
    app.use((req, res, next) => {
      const t0 = Date.now();
      res.on('finish', () => console.log(`${req.id} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t0}ms`)); // path only: never log query strings or bodies
      next();
    });
  }
  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin }));
  // keep the raw bytes: the payment webhook signature is computed over them
  app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => (req.rawBody = buf.toString('utf8')) }));

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'database unavailable' });
    }
  });

  app.use('/download', downloadsRouter);

  const v1 = express.Router();
  v1.use('/auth', authRouter);
  v1.use('/users', usersRouter);
  v1.use('/routes', routesRouter);
  v1.use('/stops', stopsRouter);
  v1.use('/vehicles', vehiclesRouter);
  v1.use('/tickets', ticketsRouter);
  v1.use('/payments', paymentsRouter);
  v1.use('/scans', scansRouter);
  v1.use('/trips', tripScansRouter); // GET /trips/:id/scans (staff or authority) before the authority-only trips router
  v1.use('/trips', tripsRouter);
  v1.use('/alerts', alertsRouter);
  v1.use('/ops', opsRouter);
  v1.use('/reports', reportsRouter);
  v1.use('/admin/auth', adminAuthRouter);
  v1.use('/admin/users', adminUsersRouter);
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
