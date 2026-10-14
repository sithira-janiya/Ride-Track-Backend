import { jest } from '@jest/globals';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { closePool, query } from '../src/config/db.js';
import { env } from '../src/config/env.js';

if (!env.db.database.endsWith('_test')) throw new Error('Refusing to run tests against a non-test database.');

const app = createApp();
const ID_TOKEN = 'header.payload.signature-from-google';
const realFetch = globalThis.fetch;

// what Google's tokeninfo endpoint returns for a valid token; individual tests override fields
const claims = (over = {}) => ({
  iss: 'https://accounts.google.com',
  aud: 'test-client.apps.googleusercontent.com',
  exp: String(Math.floor(Date.now() / 1000) + 600),
  email: 'Google.Rider@example.com',
  email_verified: 'true',
  name: 'Google Rider',
  ...over,
});
const googleReturns = (body, ok = true) => {
  globalThis.fetch = jest.fn(async () => ({ ok, json: async () => body }));
};
const signIn = () => request(app).post('/api/v1/auth/google').send({ idToken: ID_TOKEN });

beforeEach(async () => {
  await query("DELETE FROM users WHERE email = 'google.rider@example.com'");
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(async () => {
  await query("DELETE FROM users WHERE email = 'google.rider@example.com'");
  await closePool();
});

describe('POST /auth/google', () => {
  it('creates a passenger on first sign-in and logs into the same account afterwards', async () => {
    googleReturns(claims());
    const first = await signIn();
    expect(first.status).toBe(200);
    expect(first.body.data.user).toMatchObject({ name: 'Google Rider', email: 'google.rider@example.com', role: 'PASSENGER' });
    expect(first.body.data.accessToken).toBeTruthy();
    expect(globalThis.fetch.mock.calls[0][0]).toContain(encodeURIComponent(ID_TOKEN));

    const second = await signIn();
    expect(second.status).toBe(200);
    expect(second.body.data.user.userId).toBe(first.body.data.user.userId);
  });

  it.each([
    ['another app', { aud: 'someone-else.apps.googleusercontent.com' }],
    ['an unverified email', { email_verified: 'false' }],
    ['a wrong issuer', { iss: 'https://evil.example.com' }],
    ['an expired token', { exp: '1000' }],
  ])('rejects a token for %s', async (_label, over) => {
    googleReturns(claims(over));
    const res = await signIn();
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('GOOGLE_TOKEN_INVALID');
  });

  it('does not sign an admin in, since admin sessions only come from the admin sign-in', async () => {
    googleReturns(claims({ email: 'admin@ridetrack.test' }));
    const res = await signIn();
    expect(res.status).toBe(401);
    expect(res.body.data).toBeUndefined();
  });

  it('rejects a token Google does not accept', async () => {
    googleReturns({ error: 'invalid_token' }, false);
    expect((await signIn()).status).toBe(401);
  });

  it('reports when Google cannot be reached', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('network down');
    });
    const res = await signIn();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('GOOGLE_UNAVAILABLE');
  });
});
