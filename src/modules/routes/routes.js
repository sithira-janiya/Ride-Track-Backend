import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requireRole } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { send, wrap } from '../../utils/async.js';
import { getRouteVehicles } from '../vehicles/service.js';
import { addRouteStop, arrivals, createRoute, createTrip, getRoute, nearbyStops, searchRoutes, updateRoute, updateTrip } from './service.js';

const id = z.coerce.number().int().positive();
const mode = z.enum(['BUS', 'TRAIN']);

export const routesRouter = Router();

routesRouter.get(
  '/',
  validate({
    query: z.object({
      q: z.string().trim().max(100).optional(),
      mode: mode.optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  }),
  wrap(async (req, res) => send(res, await searchRoutes(req.valid.query))),
);

routesRouter.post(
  '/',
  requireAuth,
  requireRole('AUTHORITY'),
  validate({
    body: z.object({
      routeNo: z.string().trim().min(1).max(20),
      name: z.string().trim().min(2).max(150),
      mode,
      origin: z.string().trim().min(1).max(100),
      destination: z.string().trim().min(1).max(100),
    }),
  }),
  wrap(async (req, res) => send(res, await createRoute(req.valid.body), 201)),
);

routesRouter.get('/:id', validate({ params: z.object({ id }) }), wrap(async (req, res) => send(res, await getRoute(req.valid.params.id))));

routesRouter.patch(
  '/:id',
  requireAuth,
  requireRole('AUTHORITY'),
  validate({
    params: z.object({ id }),
    body: z
      .object({
        routeNo: z.string().trim().min(1).max(20),
        name: z.string().trim().min(2).max(150),
        origin: z.string().trim().min(1).max(100),
        destination: z.string().trim().min(1).max(100),
        isActive: z.boolean(),
      })
      .partial(),
  }),
  wrap(async (req, res) => send(res, await updateRoute(req.valid.params.id, req.valid.body))),
);

routesRouter.post(
  '/:id/stops',
  requireAuth,
  requireRole('AUTHORITY'),
  validate({
    params: z.object({ id }),
    body: z.object({
      stopId: id.optional(),
      name: z.string().trim().min(1).max(120).optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      stopSequence: z.number().int().min(1),
      fareFromOrigin: z.number().min(0).max(100000),
    }),
  }),
  wrap(async (req, res) => send(res, await addRouteStop(req.valid.params.id, req.valid.body), 201)),
);

routesRouter.get(
  '/:id/arrivals',
  validate({ params: z.object({ id }), query: z.object({ stopId: id }) }),
  wrap(async (req, res) => send(res, await arrivals(req.valid.params.id, req.valid.query.stopId))),
);

routesRouter.get(
  '/:id/vehicles',
  validate({ params: z.object({ id }) }),
  wrap(async (req, res) => send(res, await getRouteVehicles(req.valid.params.id))),
);

export const stopsRouter = Router();

stopsRouter.get(
  '/nearby',
  validate({
    query: z.object({
      lat: z.coerce.number().min(-90).max(90),
      lng: z.coerce.number().min(-180).max(180),
      radius: z.coerce.number().int().min(100).max(10000).default(1500),
    }),
  }),
  wrap(async (req, res) => send(res, await nearbyStops(req.valid.query))),
);

export const tripsRouter = Router();
tripsRouter.use(requireAuth, requireRole('AUTHORITY'));

const when = z.coerce.date().transform((d) => d.toISOString());

tripsRouter.post(
  '/',
  validate({ body: z.object({ routeId: id, vehicleId: id, startTime: when, endTime: when.optional() }) }),
  wrap(async (req, res) => send(res, await createTrip(req.valid.body), 201)),
);

tripsRouter.patch(
  '/:id',
  validate({
    params: z.object({ id }),
    body: z.object({
      status: z.enum(['SCHEDULED', 'ONGOING', 'DELAYED', 'CANCELLED', 'COMPLETED']).optional(),
      startTime: when.optional(),
      endTime: when.optional(),
    }),
  }),
  wrap(async (req, res) => send(res, await updateTrip(req.valid.params.id, req.valid.body))),
);
