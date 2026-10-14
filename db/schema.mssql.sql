-- RideTrack schema for Microsoft SQL Server 2017+ and Azure SQL (DB_CLIENT=mssql).
-- The same tables, columns and indexes as db/schema.sql (MySQL), translated:
--   AUTO_INCREMENT -> IDENTITY, ENUM -> NVARCHAR + CHECK, BOOLEAN -> BIT, TIMESTAMP -> DATETIME2(0) in UTC,
--   a NULL-able UNIQUE column -> a filtered unique index (SQL Server otherwise allows only one NULL),
--   text columns are NVARCHAR so they match the driver's string parameters and indexes stay usable.
-- Applied by `npm run migrate`. Every block checks first, so running it again is harmless.
-- Batches are separated by lines holding only GO.

IF OBJECT_ID('users', 'U') IS NULL
CREATE TABLE users (
  user_id               INT IDENTITY(1,1) PRIMARY KEY,
  name                  NVARCHAR(100) NOT NULL,
  email                 NVARCHAR(150) NULL,
  phone                 NVARCHAR(20)  NULL,
  password_hash         NVARCHAR(255) NOT NULL,
  role                  NVARCHAR(10)  NOT NULL CONSTRAINT df_users_role DEFAULT 'PASSENGER' CONSTRAINT chk_users_role CHECK (role IN ('PASSENGER','STAFF','AUTHORITY','ADMIN')),
  language              NVARCHAR(10)  NOT NULL CONSTRAINT df_users_language DEFAULT 'en',
  push_token            NVARCHAR(512) NULL,
  notifications_enabled BIT NOT NULL CONSTRAINT df_users_notifications DEFAULT 1,
  is_active             BIT NOT NULL CONSTRAINT df_users_active DEFAULT 1,
  created_at            DATETIME2(0) NOT NULL CONSTRAINT df_users_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT chk_contact CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_users_email' AND object_id = OBJECT_ID('users'))
  CREATE UNIQUE INDEX uq_users_email ON users (email) WHERE email IS NOT NULL;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_users_phone' AND object_id = OBJECT_ID('users'))
  CREATE UNIQUE INDEX uq_users_phone ON users (phone) WHERE phone IS NOT NULL;
GO
-- databases created before the ADMIN role: widen the role check
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'chk_users_role' AND parent_object_id = OBJECT_ID('users') AND definition NOT LIKE '%ADMIN%')
BEGIN
  ALTER TABLE users DROP CONSTRAINT chk_users_role;
  ALTER TABLE users ADD CONSTRAINT chk_users_role CHECK (role IN ('PASSENGER','STAFF','AUTHORITY','ADMIN'));
END
GO

IF OBJECT_ID('refresh_tokens', 'U') IS NULL
CREATE TABLE refresh_tokens (
  token_id    INT IDENTITY(1,1) PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash  NCHAR(64) NOT NULL CONSTRAINT uq_refresh_hash UNIQUE,
  expires_at  DATETIME2(0) NOT NULL,
  revoked     BIT NOT NULL CONSTRAINT df_refresh_revoked DEFAULT 0,
  created_at  DATETIME2(0) NOT NULL CONSTRAINT df_refresh_created DEFAULT SYSUTCDATETIME(),
  INDEX idx_refresh_user (user_id)
);
GO

IF OBJECT_ID('password_resets', 'U') IS NULL
CREATE TABLE password_resets (
  reset_id    INT IDENTITY(1,1) PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  code_hash   NCHAR(64) NOT NULL,
  expires_at  DATETIME2(0) NOT NULL,
  attempts    TINYINT NOT NULL CONSTRAINT df_reset_attempts DEFAULT 0,
  used        BIT NOT NULL CONSTRAINT df_reset_used DEFAULT 0,
  created_at  DATETIME2(0) NOT NULL CONSTRAINT df_reset_created DEFAULT SYSUTCDATETIME(),
  INDEX idx_reset_user (user_id, created_at)
);
GO

IF OBJECT_ID('routes', 'U') IS NULL
CREATE TABLE routes (
  route_id     INT IDENTITY(1,1) PRIMARY KEY,
  region       NVARCHAR(20)   NOT NULL CONSTRAINT df_routes_region DEFAULT 'SRI_LANKA',
  route_no     NVARCHAR(20)   NOT NULL,
  name         NVARCHAR(150) NOT NULL,
  mode         NVARCHAR(5)    NOT NULL CONSTRAINT chk_routes_mode CHECK (mode IN ('BUS','TRAIN')),
  origin       NVARCHAR(100) NOT NULL,
  destination  NVARCHAR(100) NOT NULL,
  is_active    BIT NOT NULL CONSTRAINT df_routes_active DEFAULT 1,
  CONSTRAINT uq_route_dir UNIQUE (region, mode, route_no, origin, destination)
);
GO

IF OBJECT_ID('stops', 'U') IS NULL
CREATE TABLE stops (
  stop_id    INT IDENTITY(1,1) PRIMARY KEY,
  name       NVARCHAR(120) NOT NULL,
  latitude   DECIMAL(9,6) NOT NULL,
  longitude  DECIMAL(9,6) NOT NULL,
  fare_zone  NVARCHAR(10)  NULL,
  INDEX idx_stops_geo (latitude, longitude)
);
GO

IF OBJECT_ID('vehicles', 'U') IS NULL
CREATE TABLE vehicles (
  vehicle_id  INT IDENTITY(1,1) PRIMARY KEY,
  reg_no      NVARCHAR(30) NOT NULL CONSTRAINT uq_vehicles_reg UNIQUE,
  type        NVARCHAR(5)  NOT NULL CONSTRAINT chk_vehicles_type CHECK (type IN ('BUS','TRAIN')),
  capacity    SMALLINT NOT NULL CONSTRAINT chk_vehicles_capacity CHECK (capacity >= 0),
  route_id    INT NOT NULL REFERENCES routes(route_id),
  is_active   BIT NOT NULL CONSTRAINT df_vehicles_active DEFAULT 1
);
GO

IF OBJECT_ID('staff', 'U') IS NULL
CREATE TABLE staff (
  user_id       INT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  employee_no   NVARCHAR(30)   NOT NULL CONSTRAINT uq_staff_employee UNIQUE,
  organisation  NVARCHAR(100) NOT NULL,
  staff_type    NVARCHAR(10)   NOT NULL CONSTRAINT chk_staff_type CHECK (staff_type IN ('CONDUCTOR','INSPECTOR')),
  vehicle_id    INT NULL REFERENCES vehicles(vehicle_id) ON DELETE SET NULL
);
GO

IF OBJECT_ID('authority_officers', 'U') IS NULL
CREATE TABLE authority_officers (
  user_id      INT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  department   NVARCHAR(100) NOT NULL,
  employee_no  NVARCHAR(30)   NOT NULL CONSTRAINT uq_officer_employee UNIQUE
);
GO

IF OBJECT_ID('route_stops', 'U') IS NULL
CREATE TABLE route_stops (
  route_id            INT NOT NULL REFERENCES routes(route_id) ON DELETE CASCADE,
  stop_id             INT NOT NULL REFERENCES stops(stop_id),
  stop_sequence       SMALLINT NOT NULL,
  fare_from_origin    DECIMAL(8,2) NOT NULL CONSTRAINT df_route_stops_fare DEFAULT 0.00,
  seconds_from_origin INT NULL,
  CONSTRAINT pk_route_stops PRIMARY KEY (route_id, stop_id),
  CONSTRAINT uq_route_seq UNIQUE (route_id, stop_sequence)
);
GO

-- service_days: Mon..Sun, '1' where it runs ('1111000' = Monday to Thursday).
-- depart_minute: minutes after midnight of the service day, in the route's region (past 1440 = after midnight).
IF OBJECT_ID('route_departures', 'U') IS NULL
CREATE TABLE route_departures (
  departure_id   INT IDENTITY(1,1) PRIMARY KEY,
  route_id       INT NOT NULL REFERENCES routes(route_id) ON DELETE CASCADE,
  service_days   NCHAR(7) NOT NULL,
  depart_minute  SMALLINT NOT NULL,
  CONSTRAINT uq_departure UNIQUE (route_id, service_days, depart_minute)
);
GO

IF OBJECT_ID('trips', 'U') IS NULL
CREATE TABLE trips (
  trip_id     INT IDENTITY(1,1) PRIMARY KEY,
  route_id    INT NOT NULL REFERENCES routes(route_id),
  vehicle_id  INT NOT NULL REFERENCES vehicles(vehicle_id),
  start_time  DATETIME2(0) NOT NULL,
  end_time    DATETIME2(0) NULL,
  status      NVARCHAR(10) NOT NULL CONSTRAINT df_trips_status DEFAULT 'SCHEDULED'
              CONSTRAINT chk_trips_status CHECK (status IN ('SCHEDULED','ONGOING','DELAYED','CANCELLED','COMPLETED')),
  INDEX idx_trip_route_time (route_id, start_time),
  INDEX idx_trip_status (status)
);
GO

IF OBJECT_ID('tickets', 'U') IS NULL
CREATE TABLE tickets (
  ticket_id       INT IDENTITY(1,1) PRIMARY KEY,
  user_id         INT NOT NULL REFERENCES users(user_id),
  trip_id         INT NOT NULL REFERENCES trips(trip_id),
  board_stop_id   INT NOT NULL REFERENCES stops(stop_id),
  alight_stop_id  INT NOT NULL REFERENCES stops(stop_id),
  qr_code         NVARCHAR(512) NULL,
  fare            DECIMAL(8,2) NOT NULL,
  status          NVARCHAR(10) NOT NULL CONSTRAINT df_tickets_status DEFAULT 'PENDING'
                  CONSTRAINT chk_tickets_status CHECK (status IN ('PENDING','ACTIVE','USED','EXPIRED','CANCELLED')),
  issued_at       DATETIME2(0) NOT NULL CONSTRAINT df_tickets_issued DEFAULT SYSUTCDATETIME(),
  INDEX idx_ticket_user (user_id, issued_at),
  INDEX idx_ticket_trip (trip_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_tickets_qr' AND object_id = OBJECT_ID('tickets'))
  CREATE UNIQUE INDEX uq_tickets_qr ON tickets (qr_code) WHERE qr_code IS NOT NULL;
GO

IF OBJECT_ID('payments', 'U') IS NULL
CREATE TABLE payments (
  payment_id   INT IDENTITY(1,1) PRIMARY KEY,
  ticket_id    INT NOT NULL CONSTRAINT uq_payments_ticket UNIQUE REFERENCES tickets(ticket_id),
  amount       DECIMAL(8,2) NOT NULL,
  method       NVARCHAR(30)  NOT NULL,
  gateway_ref  NVARCHAR(100) NULL,
  status       NVARCHAR(10) NOT NULL CONSTRAINT df_payments_status DEFAULT 'PENDING'
               CONSTRAINT chk_payments_status CHECK (status IN ('PENDING','PAID','FAILED','REFUNDED')),
  paid_at      DATETIME2(0) NULL
);
GO

IF OBJECT_ID('ticket_scans', 'U') IS NULL
CREATE TABLE ticket_scans (
  scan_id     INT IDENTITY(1,1) PRIMARY KEY,
  ticket_id   INT NULL REFERENCES tickets(ticket_id),
  staff_id    INT NOT NULL REFERENCES staff(user_id),
  result      NVARCHAR(10) NOT NULL CONSTRAINT chk_scans_result CHECK (result IN ('VALID','INVALID','MANUAL_ID')),
  scanned_at  DATETIME2(0) NOT NULL CONSTRAINT df_scans_at DEFAULT SYSUTCDATETIME(),
  INDEX idx_scan_ticket (ticket_id)
);
GO

IF OBJECT_ID('location_log', 'U') IS NULL
CREATE TABLE location_log (
  log_id       BIGINT IDENTITY(1,1) PRIMARY KEY,
  vehicle_id   INT NOT NULL REFERENCES vehicles(vehicle_id),
  latitude     DECIMAL(9,6) NOT NULL,
  longitude    DECIMAL(9,6) NOT NULL,
  eta          DATETIME2(0) NULL,
  recorded_at  DATETIME2(0) NOT NULL CONSTRAINT df_location_at DEFAULT SYSUTCDATETIME(),
  INDEX idx_loc_vehicle_time (vehicle_id, recorded_at)
);
GO

IF OBJECT_ID('occupancy_log', 'U') IS NULL
CREATE TABLE occupancy_log (
  occ_id           BIGINT IDENTITY(1,1) PRIMARY KEY,
  vehicle_id       INT NOT NULL REFERENCES vehicles(vehicle_id),
  passenger_count  SMALLINT NOT NULL,
  recorded_at      DATETIME2(0) NOT NULL CONSTRAINT df_occupancy_at DEFAULT SYSUTCDATETIME(),
  INDEX idx_occ_vehicle_time (vehicle_id, recorded_at)
);
GO

IF OBJECT_ID('delay_alerts', 'U') IS NULL
CREATE TABLE delay_alerts (
  alert_id       INT IDENTITY(1,1) PRIMARY KEY,
  trip_id        INT NOT NULL REFERENCES trips(trip_id),
  type           NVARCHAR(15) NOT NULL CONSTRAINT chk_alerts_type CHECK (type IN ('DELAY','CANCELLATION','ROUTE_CHANGE')),
  message        NVARCHAR(255) NOT NULL,
  delay_minutes  SMALLINT NULL,
  created_at     DATETIME2(0) NOT NULL CONSTRAINT df_alerts_created DEFAULT SYSUTCDATETIME(),
  INDEX idx_alert_trip (trip_id),
  INDEX idx_alert_type_time (type, created_at)
);
GO

IF OBJECT_ID('alert_recipients', 'U') IS NULL
CREATE TABLE alert_recipients (
  alert_id  INT NOT NULL REFERENCES delay_alerts(alert_id) ON DELETE CASCADE,
  user_id   INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  is_read   BIT NOT NULL CONSTRAINT df_recipients_read DEFAULT 0,
  sent_at   DATETIME2(0) NOT NULL CONSTRAINT df_recipients_sent DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_alert_recipients PRIMARY KEY (alert_id, user_id),
  INDEX idx_recipient_user (user_id, is_read)
);
GO

IF OBJECT_ID('reports', 'U') IS NULL
CREATE TABLE reports (
  report_id     INT IDENTITY(1,1) PRIMARY KEY,
  generated_by  INT NOT NULL REFERENCES authority_officers(user_id),
  route_id      INT NULL REFERENCES routes(route_id),
  report_type   NVARCHAR(10) NOT NULL CONSTRAINT chk_reports_type CHECK (report_type IN ('ROUTE','DELAY','OCCUPANCY')),
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  created_at    DATETIME2(0) NOT NULL CONSTRAINT df_reports_created DEFAULT SYSUTCDATETIME()
);
GO

-- Indexes added after the first release. Each is created only when missing, so existing databases get them too.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_trip_start' AND object_id = OBJECT_ID('trips'))
  CREATE INDEX idx_trip_start ON trips (start_time);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ticket_status_issued' AND object_id = OBJECT_ID('tickets'))
  CREATE INDEX idx_ticket_status_issued ON tickets (status, issued_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_payment_status_paid' AND object_id = OBJECT_ID('payments'))
  CREATE INDEX idx_payment_status_paid ON payments (status, paid_at);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_loc_time' AND object_id = OBJECT_ID('location_log'))
  CREATE INDEX idx_loc_time ON location_log (recorded_at);
GO
