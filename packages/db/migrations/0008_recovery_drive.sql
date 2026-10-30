-- Phase 8A (owner decisions 29/10/2026 in SPEC 30): the manager's recovery code, the Google Drive
-- watch on the server computer and the weekly "check your backups in Google Drive" confirmation.

-- ---------------------------------------------------------------- manager recovery code
-- Hashed like a password; shown once (end of install, after each use, or made again from "My account").
ALTER TABLE users
  ADD COLUMN recovery_code_hash     text,
  ADD COLUMN recovery_created_at    timestamptz,
  ADD COLUMN recovery_failed        int NOT NULL DEFAULT 0 CHECK (recovery_failed >= 0),
  ADD COLUMN recovery_locked_until  timestamptz;
ALTER TABLE users ADD CONSTRAINT users_recovery_manager CHECK (recovery_code_hash IS NULL OR role = 'manager');

-- ---------------------------------------------------------------- Google Drive watch (one row)
CREATE TABLE drive_watch (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  checked_at       timestamptz,
  running          boolean,
  last_alert_day   date,
  -- Monday of the last week the manager confirmed the backups in Google Drive.
  confirmed_week   date,
  confirmed_by     uuid REFERENCES users(id),
  confirmed_at     timestamptz
);
INSERT INTO drive_watch (id) VALUES (1);

GRANT SELECT, UPDATE ON drive_watch TO alyassir_app;
