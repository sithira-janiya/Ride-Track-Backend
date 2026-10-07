import { Server } from 'socket.io';

import { env } from '../config/env.js';
import { verifyAccessToken } from '../middleware/auth.js';

let io = null;

/** Attaches Socket.IO to the HTTP server. Clients connect with `{ auth: { token: <accessToken> } }`. */
export function initRealtime(httpServer) {
  io = new Server(httpServer, { cors: { origin: env.corsOrigin } });

  io.use((socket, next) => {
    try {
      socket.data.user = verifyAccessToken(String(socket.handshake.auth?.token ?? ''));
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const { id, role } = socket.data.user;
    socket.join(`user:${id}`);
    if (role === 'AUTHORITY') socket.join('ops');

    socket.on('route:subscribe', (p) => {
      const routeId = Number(p?.routeId);
      if (Number.isInteger(routeId) && routeId > 0) socket.join(`route:${routeId}`);
    });
    socket.on('route:unsubscribe', (p) => {
      const routeId = Number(p?.routeId);
      if (Number.isInteger(routeId) && routeId > 0) socket.leave(`route:${routeId}`);
    });
  });

  return io;
}

export const closeRealtime = () => io?.close();

export const emitToRoute = (routeId, event, payload) => io?.to(`route:${routeId}`).emit(event, payload);
export const emitToUser = (userId, event, payload) => io?.to(`user:${userId}`).emit(event, payload);

// `ops:update` tells authority dashboards to refresh. Coalesce bursts (many vehicles pinging) into one event per second.
let opsTimer = null;
let opsPending = null;
export function emitOpsUpdate(kind = 'vehicle') {
  if (!io) return;
  opsPending = opsPending ? 'multiple' : kind;
  if (opsTimer) return;
  opsTimer = setTimeout(() => {
    io?.to('ops').emit('ops:update', { kind: opsPending, at: new Date().toISOString() });
    opsTimer = null;
    opsPending = null;
  }, 1000);
  opsTimer.unref?.();
}
