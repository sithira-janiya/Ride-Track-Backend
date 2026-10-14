// Runs before anything imports src/config/env.js. Tests always use a separate database.
// MySQL by default (docker compose up -d db); TEST_DB_CLIENT=mssql runs the same tests against SQL Server.
process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = process.env.TEST_DB_CLIENT ?? 'mysql';
const mssql = process.env.DB_CLIENT === 'mssql';
process.env.DB_HOST = process.env.TEST_DB_HOST ?? 'localhost';
process.env.DB_PORT = process.env.TEST_DB_PORT ?? (mssql ? '1433' : '3307');
process.env.DB_USER = process.env.TEST_DB_USER ?? 'ridetrack';
process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD ?? 'ridetrack_dev';
process.env.DB_INSTANCE = process.env.TEST_DB_INSTANCE ?? '';
process.env.DB_TRUSTED_CONNECTION = process.env.TEST_DB_TRUSTED_CONNECTION ?? 'false';
process.env.DB_NAME = 'ridetrack_test';
process.env.ENABLE_JOBS = 'false';
process.env.PAYMENT_GATEWAY = 'mock';
process.env.GOOGLE_CLIENT_IDS = 'test-client.apps.googleusercontent.com';
