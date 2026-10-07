import crypto from 'node:crypto';
import http from 'node:http';

import { io as connect } from 'socket.io-client';
import request from 'supertest';

import { seed } from '../scripts/seed.js';
import { createApp } from '../src/app.js';
import { pool, query } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { closeRealtime, initRealtime } from '../src/realtime/index.js';
import { resetPositionsCache } from '../src/modules/vehicles/positions.js';

if (!env.db.database.endsWith('_test')) throw new Error('Refusing to run tests against a non-test database.');

const PASSWORD = 'Password1!';
const app = createApp();
const api = () => request(app);

const login = async (identifier) => {
  const res = await api().post('/api/v1/auth/login').send({ identifier, password: PASSWORD });
  expect(res.status).toBe(200);
  return { token: res.body.data.accessToken, refresh: res.body.data.refreshToken, user: res.body.data.user };
};
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const sign = (body) => crypto.createHmac('sha256', env.paymentGatewayKey).update(body).digest('hex');
const webhook = (payload, signature) => {
  const body = JSON.stringify(payload);
  return api()
    .post('/api/v1/payments/webhook')
    .set('content-type', 'application/json')
    .set('x-signature', signature ?? sign(body))
    .send(body);
};

let passenger;
let staff;
let officer;
let trip; // a bookable trip on route 1

// Rejects if `promise` has not settled after `ms`; clears its timer so nothing outlives the test.
async function within(ms, promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out')), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

// Waits for each socket to finish its close handshake, so no timers outlive the test.
async function disconnect(...sockets) {
  await Promise.all(sockets.map((c) => new Promise((resolve) => {
    if (!c.connected) return (c.close(), resolve());
    c.once('disconnect', resolve);
    c.close();
  })));
}

beforeAll(async () => {
  await seed({ reset: true });
  resetPositionsCache();
  passenger = await login('passenger@ridetrack.test');
  staff = await login('staff@ridetrack.test');
  officer = await login('officer@ridetrack.test');
  [trip] = await query("SELECT trip_id, vehicle_id FROM trips WHERE route_id = 1 AND status IN ('SCHEDULED','ONGOING') ORDER BY start_time LIMIT 1");
});

afterAll(async () => {
  await pool.end();
});

describe('health', () => {
  it('reports ok when the database is reachable', async () => {
    const res = await api().get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('answers unknown paths with the standard error body', async () => {
    const res = await api().get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('auth', () => {
  const account = { name: 'Test Rider', email: 'Rider@Example.com', password: 'Passw0rdOK' };

  it('registers a passenger and lower-cases the email', async () => {
    const res = await api().post('/api/v1/auth/register').send(account);
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({ role: 'PASSENGER', email: 'rider@example.com', name: 'Test Rider' });
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.refreshToken).toBeTruthy();
  });

  it('rejects a duplicate account with 409', async () => {
    const res = await api().post('/api/v1/auth/register').send({ ...account, email: 'rider@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_EXISTS');
  });

  it('rejects weak passwords and a missing email/phone with 400', async () => {
    expect((await api().post('/api/v1/auth/register').send({ ...account, email: 'a@b.co', password: 'short1' })).status).toBe(400);
    expect((await api().post('/api/v1/auth/register').send({ ...account, email: 'a@b.co', password: 'nodigitshere' })).status).toBe(400);
    expect((await api().post('/api/v1/auth/register').send({ name: 'No Contact', password: 'Passw0rdOK' })).status).toBe(400);
  });

  it('gives the same error for a wrong password and an unknown account', async () => {
    const wrong = await api().post('/api/v1/auth/login').send({ identifier: 'rider@example.com', password: 'WrongPass1' });
    const unknown = await api().post('/api/v1/auth/login').send({ identifier: 'nobody@example.com', password: 'WrongPass1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('logs in with the phone number format the app sends', async () => {
    await api().post('/api/v1/auth/register').send({ name: 'Phone User', phone: '0771234567', password: 'Passw0rdOK' });
    const res = await api().post('/api/v1/auth/login').send({ identifier: '077 123 4567', password: 'Passw0rdOK' });
    expect(res.status).toBe(200);
  });

  it('rotates refresh tokens: the old one stops working', async () => {
    const first = await api().post('/api/v1/auth/login').send({ identifier: 'rider@example.com', password: account.password });
    const old = first.body.data.refreshToken;
    const second = await api().post('/api/v1/auth/refresh').send({ refreshToken: old });
    expect(second.status).toBe(200);
    expect(second.body.data.refreshToken).not.toBe(old);
    const reuse = await api().post('/api/v1/auth/refresh').send({ refreshToken: old });
    expect(reuse.status).toBe(401);
  });

  it('protects /users/me and enforces roles', async () => {
    expect((await api().get('/api/v1/users/me')).status).toBe(401);
    expect((await api().get('/api/v1/users/me').set('Authorization', 'Bearer garbage')).status).toBe(401);
    const me = await api().get('/api/v1/users/me').set(auth(passenger.token));
    expect(me.body.data.email).toBe('passenger@ridetrack.test');
    expect((await api().get('/api/v1/ops/dashboard').set(auth(passenger.token))).status).toBe(403);
  });

  it('updates the profile and push token', async () => {
    const res = await api().patch('/api/v1/users/me').set(auth(passenger.token)).send({ name: 'Demo Rider', language: 'ta', notificationsEnabled: false });
    expect(res.body.data).toMatchObject({ name: 'Demo Rider', language: 'ta', notificationsEnabled: false });
    expect((await api().patch('/api/v1/users/me').set(auth(passenger.token)).send({ language: 'xx' })).status).toBe(400);
    expect((await api().put('/api/v1/users/me/push-token').set(auth(passenger.token)).send({ token: 'fcm-token-1234567890' })).status).toBe(200);
    await api().patch('/api/v1/users/me').set(auth(passenger.token)).send({ notificationsEnabled: true });
  });
});

describe('routes and stops', () => {
  it('lists and filters routes', async () => {
    const all = await api().get('/api/v1/routes');
    expect(all.body.data.map((r) => r.routeNo).sort()).toEqual(['138', '177', 'MAIN']);
    expect((await api().get('/api/v1/routes?mode=TRAIN')).body.data).toHaveLength(1);
    expect((await api().get('/api/v1/routes?q=kottawa')).body.data[0].routeNo).toBe('138');
    expect((await api().get('/api/v1/routes?q=%25')).body.data).toHaveLength(0); // wildcard characters are treated literally
  });

  it('returns a route with ordered stops and numeric fares', async () => {
    const res = await api().get('/api/v1/routes/1');
    const { stops } = res.body.data;
    expect(stops.map((s) => s.stopSequence)).toEqual([1, 2, 3, 4, 5]);
    expect(stops[0]).toMatchObject({ name: 'Colombo Fort', fareFromOrigin: 0 });
    expect(typeof stops[4].fareFromOrigin).toBe('number');
    expect((await api().get('/api/v1/routes/999')).status).toBe(404);
  });

  it('finds stops near a point, closest first', async () => {
    const res = await api().get('/api/v1/stops/nearby?lat=6.9335&lng=79.8501&radius=3000');
    const names = res.body.data.map((s) => s.name);
    expect(names[0]).toBe('Colombo Fort');
    expect(names).toContain('Maradana');
    expect(res.body.data[0].routeIds).toEqual(expect.arrayContaining([1, 2, 3]));
    const distances = res.body.data.map((s) => s.distanceMeters);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect((await api().get('/api/v1/stops/nearby?lat=abc&lng=1')).status).toBe(400);
  });

  it('lists upcoming arrivals soonest first, from the timetable when no vehicle is reporting', async () => {
    const res = await api().get('/api/v1/routes/1/arrivals?stopId=3');
    expect(res.status).toBe(200);
    const list = res.body.data;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((a) => a.scheduled === true)).toBe(true);
    expect(list.map((a) => a.eta)).toEqual([...list.map((a) => a.eta)].sort());
    expect((await api().get('/api/v1/routes/1/arrivals?stopId=8')).status).toBe(404); // Kandy is not on route 1
  });
});

describe('live tracking', () => {
  const ping = (vehicleId, lat, lng, key = env.deviceApiKey) =>
    api().post(`/api/v1/vehicles/${vehicleId}/location`).set('x-device-key', key).send({ lat, lng });

  it('rejects a wrong device key', async () => {
    expect((await ping(101, 6.93, 79.86, 'wrong')).status).toBe(401);
    expect((await api().post('/api/v1/vehicles/101/location').send({ lat: 6.93, lng: 79.86 })).status).toBe(401);
  });

  it('validates coordinates and unknown vehicles', async () => {
    expect((await ping(101, 91, 79.86)).status).toBe(400);
    expect((await ping(9999, 6.93, 79.86)).status).toBe(404);
  });

  it('stores a position and returns it with ETA and capacity', async () => {
    expect((await ping(101, 6.93, 79.855)).status).toBe(201);
    const res = await api().get('/api/v1/routes/1/vehicles');
    expect(res.body.data).toHaveLength(1); // vehicle 102 has not reported yet
    expect(res.body.data[0]).toMatchObject({ vehicleId: 101, regNo: 'NB-1234', capacity: 52, lat: 6.93, lng: 79.855 });
    expect(new Date(res.body.data[0].eta).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('records occupancy for staff only, within capacity', async () => {
    const body = { passengerCount: 30 };
    expect((await api().post('/api/v1/vehicles/101/occupancy').send(body)).status).toBe(401);
    expect((await api().post('/api/v1/vehicles/101/occupancy').set(auth(passenger.token)).send(body)).status).toBe(403);
    expect((await api().post('/api/v1/vehicles/101/occupancy').set(auth(staff.token)).send({ passengerCount: 99 })).status).toBe(400);
    const ok = await api().post('/api/v1/vehicles/101/occupancy').set(auth(staff.token)).send(body);
    expect(ok.body.data).toEqual({ vehicleId: 101, passengerCount: 30, capacity: 52 });
    const list = await api().get('/api/v1/routes/1/vehicles');
    expect(list.body.data[0].passengerCount).toBe(30);
  });

  it('pushes locations to subscribed clients over Socket.IO within a second', async () => {
    const server = http.createServer(app);
    initRealtime(server);
    await new Promise((r) => server.listen(0, r));
    const url = `http://localhost:${server.address().port}`;
    const client = connect(url, { auth: { token: passenger.token }, transports: ['websocket'] });
    const bad = connect(url, { auth: { token: 'nope' }, transports: ['websocket'], reconnection: false });
    try {
      await new Promise((r) => client.on('connect', r));
      await expect(within(3000, new Promise((resolve) => bad.on('connect_error', (e) => resolve(e.message))))).resolves.toBe('UNAUTHORIZED');
      client.emit('route:subscribe', { routeId: 1 });
      await new Promise((r) => setTimeout(r, 200));
      const got = new Promise((resolve) => client.on('vehicle:location', resolve));
      await ping(101, 6.925, 79.86);
      const msg = await within(2000, got);
      expect(msg).toMatchObject({ vehicleId: 101, lat: 6.925, lng: 79.86 });
    } finally {
      await disconnect(client, bad);
      closeRealtime();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('tickets, payment and scanning', () => {
  const buy = (body = {}) => api().post('/api/v1/tickets').set(auth(passenger.token)).send({ tripId: trip.trip_id, boardStopId: 1, alightStopId: 3, ...body });
  let ticketId;
  let qrToken;

  it('creates a pending ticket priced from the stop fares, with a payment link', async () => {
    const res = await buy();
    expect(res.status).toBe(201);
    ticketId = res.body.data.ticketId;
    expect(res.body.data.paymentUrl).toContain(`/payments/mock/checkout/${ticketId}`);
    const t = await api().get(`/api/v1/tickets/${ticketId}`).set(auth(passenger.token));
    expect(t.body.data).toMatchObject({ status: 'PENDING', fare: 50, qrToken: null, paymentStatus: 'PENDING', routeNo: '138', boardStopName: 'Colombo Fort', alightStopName: 'Borella' });
  });

  it('refuses bad stop choices and roles', async () => {
    expect((await buy({ boardStopId: 3, alightStopId: 3 })).status).toBe(400);
    expect((await buy({ boardStopId: 4, alightStopId: 1 })).status).toBe(400);
    expect((await buy({ boardStopId: 1, alightStopId: 8 })).status).toBe(400); // Kandy is not on route 1
    expect((await buy({ tripId: 99999 })).status).toBe(404);
    expect((await api().post('/api/v1/tickets').set(auth(staff.token)).send({ tripId: trip.trip_id, boardStopId: 1, alightStopId: 3 })).status).toBe(403);
  });

  it('does not activate on a bad or missing webhook signature', async () => {
    expect((await webhook({ ticketId, status: 'PAID' }, 'f'.repeat(64))).status).toBe(401);
    expect((await api().post('/api/v1/payments/webhook').send({ ticketId, status: 'PAID' })).status).toBe(401);
    const t = await api().get(`/api/v1/tickets/${ticketId}`).set(auth(passenger.token));
    expect(t.body.data.status).toBe('PENDING');
  });

  it('activates on a signed webhook, issues a QR token, and ignores duplicate callbacks', async () => {
    const first = await webhook({ ticketId, status: 'PAID', gatewayRef: 'gw-1' });
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('PAID');
    const dup = await webhook({ ticketId, status: 'PAID', gatewayRef: 'gw-1' });
    expect(dup.body.data.status).toBe('PAID');
    const t = await api().get(`/api/v1/tickets/${ticketId}`).set(auth(passenger.token));
    expect(t.body.data).toMatchObject({ status: 'ACTIVE', paymentStatus: 'PAID' });
    qrToken = t.body.data.qrToken;
    expect(qrToken).toEqual(expect.any(String));
  });

  it('serves the mock checkout page and completes a payment from it', async () => {
    const created = await buy({ boardStopId: 2, alightStopId: 4 });
    const url = new URL(created.body.data.paymentUrl);
    const page = await api().get(url.pathname + url.search);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Pay now');
    expect((await api().get(`${url.pathname}?sig=${'0'.repeat(64)}`)).status).toBe(403);
    const done = await api().post('/api/v1/payments/mock/complete').type('form').send({ ticketId: String(created.body.data.ticketId), sig: url.searchParams.get('sig'), outcome: 'paid' });
    expect(done.status).toBe(200);
    const t = await api().get(`/api/v1/tickets/${created.body.data.ticketId}`).set(auth(passenger.token));
    expect(t.body.data.status).toBe('ACTIVE');
  });

  it("keeps one passenger's tickets private", async () => {
    const other = await api().post('/api/v1/auth/register').send({ name: 'Someone Else', email: 'else@example.com', password: 'Passw0rdOK' });
    const res = await api().get(`/api/v1/tickets/${ticketId}`).set(auth(other.body.data.accessToken));
    expect(res.status).toBe(404);
    expect((await api().get('/api/v1/tickets').set(auth(other.body.data.accessToken))).body.data).toHaveLength(0);
  });

  it('lists history with a status filter and paging', async () => {
    const active = await api().get('/api/v1/tickets?status=ACTIVE').set(auth(passenger.token));
    expect(active.body.data.length).toBeGreaterThanOrEqual(2);
    expect(active.body.data.every((t) => t.status === 'ACTIVE')).toBe(true);
    const page = await api().get('/api/v1/tickets?limit=1&page=2').set(auth(passenger.token));
    expect(page.body.data).toHaveLength(1);
  });

  it('lets staff scan the QR once; a second scan is INVALID with a reason', async () => {
    expect((await api().post('/api/v1/scans').send({ qrToken })).status).toBe(401);
    expect((await api().post('/api/v1/scans').set(auth(passenger.token)).send({ qrToken })).status).toBe(403);
    const first = await api().post('/api/v1/scans').set(auth(staff.token)).send({ qrToken });
    expect(first.body.data).toMatchObject({ result: 'VALID', ticketId });
    const second = await api().post('/api/v1/scans').set(auth(staff.token)).send({ qrToken });
    expect(second.body.data).toMatchObject({ result: 'INVALID', code: 'TICKET_ALREADY_USED', reason: 'This ticket has already been scanned.' });
  });

  it('cannot double-validate under a race', async () => {
    const created = await buy();
    await webhook({ ticketId: created.body.data.ticketId, status: 'PAID' });
    const t = await api().get(`/api/v1/tickets/${created.body.data.ticketId}`).set(auth(passenger.token));
    const results = await Promise.all(Array.from({ length: 5 }, () => api().post('/api/v1/scans').set(auth(staff.token)).send({ qrToken: t.body.data.qrToken })));
    expect(results.filter((r) => r.body.data.result === 'VALID')).toHaveLength(1);
  });

  it('rejects forged, edited and unknown codes and logs every scan', async () => {
    const forged = await api().post('/api/v1/scans').set(auth(staff.token)).send({ qrToken: `${qrToken.slice(0, -4)}AAAA` });
    expect(forged.body.data).toMatchObject({ result: 'INVALID', code: 'INVALID_QR' });
    const garbage = await api().post('/api/v1/scans').set(auth(staff.token)).send({ qrToken: 'not-a-real-ticket-code' });
    expect(garbage.body.data.result).toBe('INVALID');
    expect((await api().post('/api/v1/scans').set(auth(staff.token)).send({})).status).toBe(400);
    expect((await api().post('/api/v1/scans').set(auth(staff.token)).send({ qrToken, ticketId: 1 })).status).toBe(400);
    const log = await api().get(`/api/v1/trips/${trip.trip_id}/scans`).set(auth(staff.token));
    expect(log.status).toBe(200);
    expect(log.body.data.length).toBeGreaterThanOrEqual(2);
    const [{ n }] = await query('SELECT COUNT(*) AS n FROM ticket_scans');
    expect(n).toBeGreaterThanOrEqual(8);
  });

  it('accepts a typed ticket number, and reasons for unpaid and unknown tickets', async () => {
    const unpaid = await buy();
    expect((await api().post('/api/v1/scans').set(auth(staff.token)).send({ ticketId: unpaid.body.data.ticketId })).body.data.code).toBe('TICKET_NOT_PAID');
    await webhook({ ticketId: unpaid.body.data.ticketId, status: 'PAID' });
    expect((await api().post('/api/v1/scans').set(auth(staff.token)).send({ ticketId: unpaid.body.data.ticketId })).body.data.result).toBe('VALID');
    expect((await api().post('/api/v1/scans').set(auth(staff.token)).send({ ticketId: 987654 })).body.data.code).toBe('TICKET_NOT_FOUND');
  });

  it('cancels an unused ticket with a refund, but not a used or already cancelled one', async () => {
    const created = await buy();
    const id = created.body.data.ticketId;
    expect((await api().post(`/api/v1/tickets/${id}/cancel`).set(auth(passenger.token))).status).toBe(409); // still pending
    await webhook({ ticketId: id, status: 'PAID' });
    const cancelled = await api().post(`/api/v1/tickets/${id}/cancel`).set(auth(passenger.token));
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', qrToken: null });
    expect((await api().post(`/api/v1/tickets/${id}/cancel`).set(auth(passenger.token))).status).toBe(409);
    const used = await api().post(`/api/v1/tickets/${ticketId}/cancel`).set(auth(passenger.token));
    expect(used.status).toBe(409);
    expect(used.body.error.code).toBe('TICKET_ALREADY_USED');
  });

  it('cancels the ticket when the gateway reports a failed payment, and refunds a late payment', async () => {
    const failed = await buy();
    await webhook({ ticketId: failed.body.data.ticketId, status: 'FAILED' });
    expect((await api().get(`/api/v1/tickets/${failed.body.data.ticketId}`).set(auth(passenger.token))).body.data).toMatchObject({ status: 'CANCELLED', paymentStatus: 'FAILED' });

    const late = await buy();
    await query("UPDATE tickets SET status = 'EXPIRED' WHERE ticket_id = ?", [late.body.data.ticketId]);
    const res = await webhook({ ticketId: late.body.data.ticketId, status: 'PAID' });
    expect(res.body.data.status).toBe('REFUNDED');
  });
});

describe('alerts', () => {
  it('delivers a published alert to ticket holders, and lets them mark it read', async () => {
    const holder = await buy();
    await webhook({ ticketId: holder.body.data.ticketId, status: 'PAID' });
    const text = 'Road works near Nugegoda, expect delays.';
    expect((await api().post('/api/v1/alerts').set(auth(passenger.token)).send({ tripId: trip.trip_id, type: 'DELAY', message: text })).status).toBe(403);
    expect((await api().post('/api/v1/alerts').set(auth(officer.token)).send({ tripId: trip.trip_id, type: 'DELAY', message: 'no' })).status).toBe(400);
    const pub = await api().post('/api/v1/alerts').set(auth(officer.token)).send({ tripId: trip.trip_id, type: 'DELAY', message: text, delayMinutes: 12 });
    expect(pub.status).toBe(201);

    const unread = await api().get('/api/v1/alerts?unread=true').set(auth(passenger.token));
    expect(unread.body.data[0]).toMatchObject({ alertId: pub.body.data.alertId, message: text, delayMinutes: 12, isRead: false });

    const read = await api().patch(`/api/v1/alerts/${pub.body.data.alertId}/read`).set(auth(passenger.token));
    expect(read.body.data.isRead).toBe(true);
    expect((await api().get('/api/v1/alerts?unread=true').set(auth(passenger.token))).body.data).toHaveLength(0);
    expect((await api().get('/api/v1/alerts').set(auth(passenger.token))).body.data).toHaveLength(1);
    expect((await api().patch('/api/v1/alerts/99999/read').set(auth(passenger.token))).status).toBe(404);

    const officerView = await api().get('/api/v1/alerts').set(auth(officer.token));
    expect(officerView.body.data.map((a) => a.alertId)).toContain(pub.body.data.alertId);
  });

  it('pushes alert:new to the passenger over Socket.IO', async () => {
    const server = http.createServer(app);
    initRealtime(server);
    await new Promise((r) => server.listen(0, r));
    const client = connect(`http://localhost:${server.address().port}`, { auth: { token: passenger.token }, transports: ['websocket'] });
    try {
      await new Promise((r) => client.on('connect', r));
      const got = new Promise((resolve) => client.on('alert:new', resolve));
      await api().post('/api/v1/alerts').set(auth(officer.token)).send({ tripId: trip.trip_id, type: 'ROUTE_CHANGE', message: 'Stops are changing today.' });
      const msg = await within(2000, got);
      expect(msg).toMatchObject({ tripId: trip.trip_id, type: 'ROUTE_CHANGE' });
    } finally {
      await disconnect(client);
      closeRealtime();
      await new Promise((r) => server.close(r));
    }
  });

  it('cancels the trip and its tickets when a cancellation is published', async () => {
    const [other] = await query("SELECT trip_id FROM trips WHERE route_id = 1 AND status = 'SCHEDULED' AND trip_id <> ? ORDER BY start_time LIMIT 1", [trip.trip_id]);
    const t = await buy({ tripId: other.trip_id });
    await webhook({ ticketId: t.body.data.ticketId, status: 'PAID' });
    await api().post('/api/v1/alerts').set(auth(officer.token)).send({ tripId: other.trip_id, type: 'CANCELLATION', message: 'This trip is cancelled.' });
    const [row] = await query('SELECT status FROM trips WHERE trip_id = ?', [other.trip_id]);
    expect(row.status).toBe('CANCELLED');
    const { expireTickets } = await import('../src/jobs/index.js');
    await expireTickets();
    const after = await api().get(`/api/v1/tickets/${t.body.data.ticketId}`).set(auth(passenger.token));
    expect(after.body.data).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED' });
    expect((await buy({ tripId: other.trip_id })).status).toBe(409); // cannot buy for a cancelled trip
  });
});

describe('authority', () => {
  it('returns the live dashboard', async () => {
    const res = await api().get('/api/v1/ops/dashboard').set(auth(officer.token));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.vehicles[0]).toEqual(expect.objectContaining({ vehicleId: expect.any(Number), routeNo: expect.any(String), mode: expect.any(String), lat: expect.any(Number) }));
    expect(d.occupancy).toEqual({ totalPassengers: 30, totalCapacity: 52, fullVehicles: 0 });
    expect(d.activeDelays.length).toBeGreaterThan(0);
  });

  it.each(['ROUTE_PERFORMANCE', 'DELAYS', 'OCCUPANCY'])('generates a %s report and saves it', async (type) => {
    const day = new Date().toISOString().slice(0, 10);
    const res = await api().get(`/api/v1/reports?type=${type}&from=${day}&to=${day}`).set(auth(officer.token));
    expect(res.status).toBe(200);
    const r = res.body.data;
    expect(r).toMatchObject({ type, from: day, to: day, chartColumn: 0 });
    expect(r.columns.length).toBeGreaterThan(0);
    for (const row of r.rows) expect(row.values).toHaveLength(r.columns.length);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('validates report filters', async () => {
    const q = (s) => api().get(`/api/v1/reports?${s}`).set(auth(officer.token));
    expect((await q('type=NOPE&from=2026-01-01&to=2026-01-02')).status).toBe(400);
    expect((await q('type=DELAYS&from=2026-01-05&to=2026-01-01')).status).toBe(400);
    expect((await q('type=DELAYS&from=yesterday&to=today')).status).toBe(400);
    expect((await api().get('/api/v1/reports?type=DELAYS&from=2026-01-01&to=2026-01-02').set(auth(passenger.token))).status).toBe(403);
    const [{ n }] = await query('SELECT COUNT(*) AS n FROM reports');
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('lets an officer manage routes, stops and trips', async () => {
    const created = await api().post('/api/v1/routes').set(auth(officer.token)).send({ routeNo: '99', name: 'Test Route', mode: 'BUS', origin: 'A', destination: 'B' });
    expect(created.status).toBe(201);
    const id = created.body.data.routeId;
    expect((await api().post('/api/v1/routes').set(auth(officer.token)).send({ routeNo: '99', name: 'Dup', mode: 'BUS', origin: 'A', destination: 'B' })).status).toBe(409);
    expect((await api().post('/api/v1/routes').set(auth(passenger.token)).send({ routeNo: '98', name: 'No', mode: 'BUS', origin: 'A', destination: 'B' })).status).toBe(403);
    const withStop = await api().post(`/api/v1/routes/${id}/stops`).set(auth(officer.token)).send({ name: 'New Stop', latitude: 6.9, longitude: 79.9, stopSequence: 1, fareFromOrigin: 0 });
    expect(withStop.body.data.stops).toHaveLength(1);
    expect((await api().patch(`/api/v1/routes/${id}`).set(auth(officer.token)).send({ name: 'Renamed' })).body.data.name).toBe('Renamed');
    const startTime = new Date(Date.now() + 3600000).toISOString();
    expect((await api().post('/api/v1/trips').set(auth(officer.token)).send({ routeId: id, vehicleId: 101, startTime })).status).toBe(400); // vehicle 101 is on another route
    const t = await api().post('/api/v1/trips').set(auth(officer.token)).send({ routeId: 1, vehicleId: 101, startTime });
    expect(t.status).toBe(201);
    expect((await api().patch(`/api/v1/trips/${t.body.data.tripId}`).set(auth(officer.token)).send({ status: 'CANCELLED' })).body.data.status).toBe('CANCELLED');
  });
});

describe('background jobs', () => {
  it('advances trips by the clock', async () => {
    const { advanceTrips } = await import('../src/jobs/index.js');
    await query("INSERT INTO trips (route_id, vehicle_id, start_time, end_time, status) VALUES (3, 301, UTC_TIMESTAMP() - INTERVAL 5 MINUTE, UTC_TIMESTAMP() + INTERVAL 30 MINUTE, 'SCHEDULED')");
    await query("INSERT INTO trips (route_id, vehicle_id, start_time, end_time, status) VALUES (3, 301, UTC_TIMESTAMP() - INTERVAL 90 MINUTE, UTC_TIMESTAMP() - INTERVAL 5 MINUTE, 'ONGOING')");
    await advanceTrips();
    const rows = await query('SELECT status FROM trips WHERE route_id = 3 AND vehicle_id = 301 ORDER BY trip_id DESC LIMIT 2');
    expect(rows.map((r) => r.status).sort()).toEqual(['COMPLETED', 'ONGOING']);
  });

  it('expires unpaid tickets after 30 minutes', async () => {
    const { expireTickets } = await import('../src/jobs/index.js');
    const created = await api().post('/api/v1/tickets').set(auth(passenger.token)).send({ tripId: trip.trip_id, boardStopId: 1, alightStopId: 2 });
    await query('UPDATE tickets SET issued_at = UTC_TIMESTAMP() - INTERVAL 31 MINUTE WHERE ticket_id = ?', [created.body.data.ticketId]);
    await expireTickets();
    const t = await api().get(`/api/v1/tickets/${created.body.data.ticketId}`).set(auth(passenger.token));
    expect(t.body.data).toMatchObject({ status: 'EXPIRED', paymentStatus: 'FAILED' });
  });
});

function buy(body = {}) {
  return api().post('/api/v1/tickets').set(auth(passenger.token)).send({ tripId: trip.trip_id, boardStopId: 1, alightStopId: 3, ...body });
}
