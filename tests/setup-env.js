// Runs before anything imports src/config/env.js. Tests always use a separate database.
process.env.NODE_ENV = 'test';
process.env.DB_HOST = process.env.TEST_DB_HOST ?? 'localhost';
process.env.DB_PORT = process.env.TEST_DB_PORT ?? '3307';
process.env.DB_USER = process.env.TEST_DB_USER ?? 'ridetrack';
process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD ?? 'ridetrack_dev';
process.env.DB_NAME = 'ridetrack_test';
process.env.ENABLE_JOBS = 'false';
process.env.PAYMENT_GATEWAY = 'mock';
