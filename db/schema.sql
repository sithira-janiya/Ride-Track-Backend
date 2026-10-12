-- RideTrack MySQL 8 schema.
-- Based on docs/06-database-mysql.md in the RideTrack Development repo, plus:
--   users.notifications_enabled   (PATCH /users/me notification preference)
--   refresh_tokens                (rotating refresh tokens, stored hashed)
--   password_resets               (one-time forgot-password codes, stored hashed)
--   routes.region                 (SRI_LANKA or DUBAI: the timetable's time zone and the fare currency)
--   stops.fare_zone               (Dubai RTA fare zone: zone fares count the zones a trip touches)
--   route_stops.seconds_from_origin (timetabled running time from the first stop)
--   route_departures              (the timetable: departures from the first stop by day of the week)
--   idx_trip_start, idx_ticket_status_issued, idx_payment_status_paid, idx_loc_time
--                                 (the per-minute jobs, the admin overview and the 90-day GPS purge)
-- db/schema.mssql.sql is the same schema for SQL Server; change both together.
-- Applied by `npm run migrate`. Safe to run more than once.

CREATE TABLE IF NOT EXISTS users (
  user_id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name                  VARCHAR(100) NOT NULL,
  email                 VARCHAR(150) NULL UNIQUE,
  phone                 VARCHAR(20)  NULL UNIQUE,
  password_hash         VARCHAR(255) NOT NULL,
  role                  ENUM('PASSENGER','STAFF','AUTHORITY') NOT NULL DEFAULT 'PASSENGER',
  language              VARCHAR(10)  NOT NULL DEFAULT 'en',
  push_token            VARCHAR(512) NULL,
  notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_contact CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  DATETIME NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_refresh_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS password_resets (
  reset_id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  code_hash   CHAR(64) NOT NULL,
  expires_at  DATETIME NOT NULL,
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_reset_user (user_id, created_at),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS routes (
  route_id     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  region       VARCHAR(20)  NOT NULL DEFAULT 'SRI_LANKA',
  route_no     VARCHAR(20)  NOT NULL,
  name         VARCHAR(150) NOT NULL,
  mode         ENUM('BUS','TRAIN') NOT NULL,
  origin       VARCHAR(100) NOT NULL,
  destination  VARCHAR(100) NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE KEY uq_route_dir (region, mode, route_no, origin, destination)
);

CREATE TABLE IF NOT EXISTS stops (
  stop_id    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  latitude   DECIMAL(9,6) NOT NULL,
  longitude  DECIMAL(9,6) NOT NULL,
  fare_zone  VARCHAR(10)  NULL,
  INDEX idx_stops_geo (latitude, longitude)
);

CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_id  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  reg_no      VARCHAR(30) NOT NULL UNIQUE,
  type        ENUM('BUS','TRAIN') NOT NULL,
  capacity    SMALLINT UNSIGNED NOT NULL,
  route_id    INT UNSIGNED NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY (route_id) REFERENCES routes(route_id)
);

CREATE TABLE IF NOT EXISTS staff (
  user_id       INT UNSIGNED PRIMARY KEY,
  employee_no   VARCHAR(30) NOT NULL UNIQUE,
  organisation  VARCHAR(100) NOT NULL,
  staff_type    ENUM('CONDUCTOR','INSPECTOR') NOT NULL,
  vehicle_id    INT UNSIGNED NULL,
  FOREIGN KEY (user_id)    REFERENCES users(user_id)       ON DELETE CASCADE,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(vehicle_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS authority_officers (
  user_id      INT UNSIGNED PRIMARY KEY,
  department   VARCHAR(100) NOT NULL,
  employee_no  VARCHAR(30)  NOT NULL UNIQUE,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS route_stops (
  route_id         INT UNSIGNED NOT NULL,
  stop_id          INT UNSIGNED NOT NULL,
  stop_sequence    SMALLINT UNSIGNED NOT NULL,
  fare_from_origin DECIMAL(8,2) NOT NULL DEFAULT 0.00,
  seconds_from_origin INT UNSIGNED NULL,
  PRIMARY KEY (route_id, stop_id),
  UNIQUE KEY uq_route_seq (route_id, stop_sequence),
  FOREIGN KEY (route_id) REFERENCES routes(route_id) ON DELETE CASCADE,
  FOREIGN KEY (stop_id)  REFERENCES stops(stop_id)
);

-- service_days: Mon..Sun, '1' where it runs ('1111000' = Monday to Thursday).
-- depart_minute: minutes after midnight of the service day, in the route's region (past 1440 = after midnight).
CREATE TABLE IF NOT EXISTS route_departures (
  departure_id   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  route_id       INT UNSIGNED NOT NULL,
  service_days   CHAR(7) NOT NULL,
  depart_minute  SMALLINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_departure (route_id, service_days, depart_minute),
  FOREIGN KEY (route_id) REFERENCES routes(route_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trips (
  trip_id     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  route_id    INT UNSIGNED NOT NULL,
  vehicle_id  INT UNSIGNED NOT NULL,
  start_time  DATETIME NOT NULL,
  end_time    DATETIME NULL,
  status      ENUM('SCHEDULED','ONGOING','DELAYED','CANCELLED','COMPLETED') NOT NULL DEFAULT 'SCHEDULED',
  INDEX idx_trip_route_time (route_id, start_time),
  INDEX idx_trip_start (start_time),
  INDEX idx_trip_status (status),
  FOREIGN KEY (route_id)   REFERENCES routes(route_id),
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(vehicle_id)
);

CREATE TABLE IF NOT EXISTS tickets (
  ticket_id       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED NOT NULL,
  trip_id         INT UNSIGNED NOT NULL,
  board_stop_id   INT UNSIGNED NOT NULL,
  alight_stop_id  INT UNSIGNED NOT NULL,
  qr_code         VARCHAR(512) NULL UNIQUE,
  fare            DECIMAL(8,2) NOT NULL,
  status          ENUM('PENDING','ACTIVE','USED','EXPIRED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  issued_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ticket_user (user_id, issued_at),
  INDEX idx_ticket_trip (trip_id),
  INDEX idx_ticket_status_issued (status, issued_at),
  FOREIGN KEY (user_id)        REFERENCES users(user_id),
  FOREIGN KEY (trip_id)        REFERENCES trips(trip_id),
  FOREIGN KEY (board_stop_id)  REFERENCES stops(stop_id),
  FOREIGN KEY (alight_stop_id) REFERENCES stops(stop_id)
);

CREATE TABLE IF NOT EXISTS payments (
  payment_id   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id    INT UNSIGNED NOT NULL UNIQUE,
  amount       DECIMAL(8,2) NOT NULL,
  method       VARCHAR(30)  NOT NULL,
  gateway_ref  VARCHAR(100) NULL,
  status       ENUM('PENDING','PAID','FAILED','REFUNDED') NOT NULL DEFAULT 'PENDING',
  paid_at      TIMESTAMP NULL,
  INDEX idx_payment_status_paid (status, paid_at),
  FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id)
);

CREATE TABLE IF NOT EXISTS ticket_scans (
  scan_id     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id   INT UNSIGNED NULL,
  staff_id    INT UNSIGNED NOT NULL,
  result      ENUM('VALID','INVALID','MANUAL_ID') NOT NULL,
  scanned_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_scan_ticket (ticket_id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id),
  FOREIGN KEY (staff_id)  REFERENCES staff(user_id)
);

CREATE TABLE IF NOT EXISTS location_log (
  log_id       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  vehicle_id   INT UNSIGNED NOT NULL,
  latitude     DECIMAL(9,6) NOT NULL,
  longitude    DECIMAL(9,6) NOT NULL,
  eta          DATETIME NULL,
  recorded_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_loc_vehicle_time (vehicle_id, recorded_at),
  INDEX idx_loc_time (recorded_at),
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(vehicle_id)
);

CREATE TABLE IF NOT EXISTS occupancy_log (
  occ_id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  vehicle_id       INT UNSIGNED NOT NULL,
  passenger_count  SMALLINT UNSIGNED NOT NULL,
  recorded_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_occ_vehicle_time (vehicle_id, recorded_at),
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(vehicle_id)
);

CREATE TABLE IF NOT EXISTS delay_alerts (
  alert_id       INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  trip_id        INT UNSIGNED NOT NULL,
  type           ENUM('DELAY','CANCELLATION','ROUTE_CHANGE') NOT NULL,
  message        VARCHAR(255) NOT NULL,
  delay_minutes  SMALLINT UNSIGNED NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_alert_trip (trip_id),
  INDEX idx_alert_type_time (type, created_at),
  FOREIGN KEY (trip_id) REFERENCES trips(trip_id)
);

CREATE TABLE IF NOT EXISTS alert_recipients (
  alert_id  INT UNSIGNED NOT NULL,
  user_id   INT UNSIGNED NOT NULL,
  is_read   BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (alert_id, user_id),
  INDEX idx_recipient_user (user_id, is_read),
  FOREIGN KEY (alert_id) REFERENCES delay_alerts(alert_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(user_id)         ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reports (
  report_id     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  generated_by  INT UNSIGNED NOT NULL,
  route_id      INT UNSIGNED NULL,
  report_type   ENUM('ROUTE','DELAY','OCCUPANCY') NOT NULL,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (generated_by) REFERENCES authority_officers(user_id),
  FOREIGN KEY (route_id)     REFERENCES routes(route_id)
);
