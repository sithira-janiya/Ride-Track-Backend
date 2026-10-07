-- Creates the throwaway database the automated tests use, and lets the app user manage it.
CREATE DATABASE IF NOT EXISTS ridetrack_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON ridetrack_test.* TO 'ridetrack'@'%';
FLUSH PRIVILEGES;
