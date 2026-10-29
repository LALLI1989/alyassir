-- Phase 6B: backups (SPEC 20, 20.1). Owner decisions 29/10/2026 (SPEC 30): the server writes its
-- backups to an ordinary folder that the Google Drive app uploads; hourly backups during working
-- hours (Monday to Saturday 08:00-19:00 by default, kept 30 days); a daily backup kept 6 months;
-- a USB copy once a month (first Friday 13:00: reminder, then blocking from the next working day).

-- ---------------------------------------------------------------- working hours and USB time
ALTER TABLE agency_settings
  -- ISO days of the week (1 = Monday ... 7 = Sunday).
  ADD COLUMN work_days  smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6}'
    CHECK (cardinality(work_days) BETWEEN 1 AND 7 AND work_days <@ '{1,2,3,4,5,6,7}'::smallint[]),
  ADD COLUMN work_start time NOT NULL DEFAULT '08:00',
  ADD COLUMN work_end   time NOT NULL DEFAULT '19:00',
  ADD COLUMN usb_time   time NOT NULL DEFAULT '13:00',
  ADD CONSTRAINT agency_settings_work_hours CHECK (work_start < work_end);

-- ---------------------------------------------------------------- backup runs (history and schedule)
CREATE TABLE backup_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('hourly', 'daily', 'usb', 'manual', 'safety')),
  -- The period it covers: "2026-10-29T10" (hourly), "2026-10-29" (daily), "2026-11" (usb); unique per kind.
  slot          text NOT NULL,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
  file_name     text,
  size_bytes    bigint CHECK (size_bytes >= 0),
  sha256        text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  error         text,
  requested_by  uuid REFERENCES users (id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  CONSTRAINT backup_runs_done CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT backup_runs_ok CHECK (status <> 'ok' OR (file_name IS NOT NULL AND sha256 IS NOT NULL)),
  CONSTRAINT backup_runs_failed CHECK (status <> 'failed' OR error IS NOT NULL)
);
-- A failed run may be tried again for the same period; a running or good one may not.
CREATE UNIQUE INDEX backup_runs_slot ON backup_runs (kind, slot) WHERE status <> 'failed';
CREATE INDEX backup_runs_recent ON backup_runs (started_at DESC);

-- ---------------------------------------------------------------- monthly USB copy (one row per month)
CREATE TABLE usb_backup_gates (
  month         text PRIMARY KEY CHECK (month ~ '^\d{4}-\d{2}$'),
  due_on        date NOT NULL,
  -- From this instant everyone works with a reminder; from block_from the application stops.
  remind_from   timestamptz NOT NULL,
  block_from    timestamptz NOT NULL,
  done_at       timestamptz,
  done_by       uuid REFERENCES users (id),
  done_file     text,
  skipped_at    timestamptz,
  skipped_by    uuid REFERENCES users (id),
  skip_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usb_gates_order CHECK (remind_from <= block_from),
  CONSTRAINT usb_gates_done CHECK ((done_at IS NULL) = (done_by IS NULL)),
  CONSTRAINT usb_gates_skip CHECK ((skipped_at IS NULL) = (skipped_by IS NULL) AND (skipped_at IS NULL OR length(coalesce(skip_reason, '')) > 0))
);

GRANT SELECT, INSERT, UPDATE (status, file_name, size_bytes, sha256, error, finished_at) ON backup_runs TO alyassir_app;
GRANT SELECT, INSERT, UPDATE (done_at, done_by, done_file, skipped_at, skipped_by, skip_reason) ON usb_backup_gates TO alyassir_app;
