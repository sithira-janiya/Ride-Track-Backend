import 'dotenv/config';

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

// Secrets must be set explicitly in production; in development and tests a clearly fake default keeps setup quick.
const secret = (name, devDefault) => {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`Missing required environment variable ${name}`);
  return devDefault;
};

const int = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

function corsOrigins(value) {
  const list = value.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  return list.length === 0 || list.includes('*') ? true : list;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd,
  isTest,
  port: int('PORT', 3000),
  /** Public base URL of this API (used to build payment page links). */
  publicUrl: (
    process.env.PUBLIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${int('PORT', 3000)}`)
  ).replace(/\/+$/, ''),
  /** `true` (reflect any origin) for "*", otherwise the comma-separated list of allowed origins. */
  corsOrigin: corsOrigins(process.env.CORS_ORIGIN ?? '*'),
  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: int('DB_PORT', 3306),
    user: process.env.DB_USER ?? 'ridetrack',
    password: isProd ? secret('DB_PASSWORD') : (process.env.DB_PASSWORD ?? 'ridetrack_dev'),
    database: process.env.DB_NAME ?? (isTest ? 'ridetrack_test' : 'ridetrack'),
    ssl: process.env.DB_SSL === 'true',
  },
  jwtAccessSecret: secret('JWT_ACCESS_SECRET', 'dev-access-secret-change-me'),
  jwtRefreshTtlDays: int('JWT_REFRESH_TTL_DAYS', 30),
  accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
  /** Admin refresh tokens last hours, not days: an admin signs in again at least this often. */
  adminRefreshTtlHours: int('ADMIN_REFRESH_TTL_HOURS', 12),
  qrSigningSecret: secret('QR_SIGNING_SECRET', 'dev-qr-secret-change-me'),
  paymentGateway: process.env.PAYMENT_GATEWAY ?? 'mock',
  paymentGatewayKey: secret('PAYMENT_GATEWAY_KEY', 'dev-gateway-key-change-me'),
  /** Shared key GPS devices send as `x-device-key` when posting locations. */
  deviceApiKey: secret('DEVICE_API_KEY', 'dev-device-key-change-me'),
  fcmServiceAccount: process.env.FCM_SERVICE_ACCOUNT ?? '',
  enableJobs: (process.env.ENABLE_JOBS ?? (isTest ? 'false' : 'true')) === 'true',
  /** A vehicle position older than this is treated as "not live" when working out ETAs. */
  livePositionMaxAgeMs: int('LIVE_POSITION_MAX_AGE_SECONDS', 120) * 1000,
};

if (isProd && env.paymentGateway === 'mock' && process.env.ALLOW_MOCK_PAYMENTS !== 'true') {
  throw new Error('PAYMENT_GATEWAY=mock is not allowed in production. Set ALLOW_MOCK_PAYMENTS=true to override for a demo deployment.');
}
