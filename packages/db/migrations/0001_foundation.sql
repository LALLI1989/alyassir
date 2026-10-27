-- Phase 1 foundation: users, permissions, sessions, audit, messages, edit requests, settings.
-- Runs as the database owner. The application connects as alyassir_app, which gets only the
-- rights granted at the end of this file (no ALTER, no DROP, no TRUNCATE).

-- ---------------------------------------------------------------- system
CREATE TABLE system_info (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  min_client_version text NOT NULL DEFAULT '0.1.0',
  historical_mode    text NOT NULL DEFAULT 'open' CHECK (historical_mode IN ('open', 'locked')),
  go_live_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_info (id) VALUES (1);

-- Gap-free numbering per name and year (receipts from Phase 3).
CREATE TABLE sequences (
  name       text   NOT NULL,
  year       int    NOT NULL,
  last_value bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  PRIMARY KEY (name, year)
);

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username            text NOT NULL CHECK (username ~ '^[a-zA-Z0-9._-]{3,32}$'),
  display_name        text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  password_hash       text NOT NULL,
  role                text NOT NULL CHECK (role IN ('manager', 'employee')),
  is_supervisor       boolean NOT NULL DEFAULT false,
  language            text CHECK (language IN ('ar', 'fr')),
  is_active           boolean NOT NULL DEFAULT true,
  failed_attempts     int NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until        timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             int NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at         timestamptz,
  -- The supervisor is an employee with extra powers, never a third role (SPEC 7.1).
  CONSTRAINT users_supervisor_is_employee CHECK (role = 'employee' OR NOT is_supervisor),
  -- The only manager can never be disabled (SPEC 4.16).
  CONSTRAINT users_manager_active CHECK (role <> 'manager' OR is_active)
);
CREATE UNIQUE INDEX users_username_unique ON users (lower(username));
-- Exactly one manager (SPEC 7.1): a partial unique index.
CREATE UNIQUE INDEX users_single_manager ON users (role) WHERE role = 'manager';

CREATE TABLE permissions (
  code text PRIMARY KEY
);
INSERT INTO permissions (code) VALUES
  ('clients.view'), ('clients.create'), ('clients.edit'),
  ('vehicles.view'), ('vehicles.create'), ('vehicles.edit'),
  ('policies.view'), ('policies.create'), ('policies.edit'),
  ('payments.view'), ('payments.create'), ('payments.edit'),
  ('debts.view'), ('debts.create'), ('debts.edit'),
  ('expenses.view'), ('expenses.create'), ('expenses.edit'),
  ('closing.view'), ('closing.create'), ('closing.edit'),
  ('claims.view'), ('claims.create'), ('claims.edit'),
  ('reports.view'), ('reports.create'), ('reports.edit'),
  ('finance_dashboard.view'), ('finance_dashboard.create'), ('finance_dashboard.edit'),
  ('export'), ('drawer_balance.view'),
  ('sup.policy_edit_after_48h'), ('sup.confirm_collection'), ('sup.approve_expenses'),
  ('sup.transfers'), ('sup.refunds'), ('sup.insurer_payments_withdrawals'),
  ('sup.skip_usb_backup'), ('sup.close_session_on_behalf');

CREATE TABLE user_permissions (
  user_id    uuid NOT NULL REFERENCES users (id),
  code       text NOT NULL REFERENCES permissions (code),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES users (id),
  PRIMARY KEY (user_id, code)
);

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users (id),
  refresh_token_hash text NOT NULL UNIQUE,
  device             text,
  ip                 text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_activity_at   timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_reason     text
);
CREATE INDEX sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- audit (append-only)
CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  user_id       uuid REFERENCES users (id),
  action        text NOT NULL,
  entity_type   text,
  entity_id     text,
  before        jsonb,
  after         jsonb,
  reason        text,
  device        text,
  ip            text,
  is_historical boolean NOT NULL DEFAULT false
);
CREATE INDEX audit_log_entity ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_at ON audit_log (at DESC);
CREATE INDEX audit_log_user ON audit_log (user_id, at DESC);

-- Shared guard for every append-only table (also used by financial_transactions later).
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- messages
CREATE TABLE message_threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject         text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  kind            text NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'system')),
  edit_request_id uuid,
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  uuid NOT NULL REFERENCES message_threads (id),
  -- NULL sender = automatic system message.
  sender_id  uuid REFERENCES users (id),
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread ON messages (thread_id, created_at);

CREATE TABLE message_recipients (
  message_id uuid NOT NULL REFERENCES messages (id),
  user_id    uuid NOT NULL REFERENCES users (id),
  kind       text NOT NULL CHECK (kind IN ('to', 'cc')),
  read_at    timestamptz,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_recipients_unread ON message_recipients (user_id) WHERE read_at IS NULL;

-- Per-user notices (used by automatic alerts in later phases).
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id),
  kind       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX notifications_unread ON notifications (user_id) WHERE read_at IS NULL;

-- ---------------------------------------------------------------- edit requests (SPEC 8)
CREATE TABLE edit_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id    uuid NOT NULL REFERENCES users (id),
  entity_type     text NOT NULL,
  entity_id       uuid NOT NULL,
  operation       text NOT NULL,
  note            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'used', 'expired')),
  decision_reason text,
  decided_by      uuid REFERENCES users (id),
  decided_at      timestamptz,
  expires_at      timestamptz,
  used_at         timestamptz,
  thread_id       uuid REFERENCES message_threads (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  CONSTRAINT edit_requests_decision CHECK (
    (status = 'pending' AND decided_at IS NULL)
    OR (status IN ('approved', 'used', 'expired') AND decided_at IS NOT NULL AND decision_reason IS NOT NULL
        AND expires_at IS NOT NULL)
    OR (status = 'rejected' AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
  )
);
CREATE INDEX edit_requests_grant ON edit_requests (requester_id, entity_type, entity_id, operation)
  WHERE status = 'approved';
CREATE INDEX edit_requests_status ON edit_requests (status, created_at DESC);
ALTER TABLE message_threads
  ADD CONSTRAINT message_threads_edit_request FOREIGN KEY (edit_request_id) REFERENCES edit_requests (id);

-- ---------------------------------------------------------------- agency settings (one row)
CREATE TABLE agency_settings (
  id                   smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name_ar              text NOT NULL,
  name_fr              text NOT NULL,
  address              text NOT NULL DEFAULT '',
  phone                text NOT NULL DEFAULT '',
  license_number       text NOT NULL DEFAULT '',
  logo                 bytea CHECK (logo IS NULL OR octet_length(logo) <= 512000),
  logo_type            text CHECK (logo_type IN ('image/png', 'image/jpeg')),
  idle_timeout_minutes int NOT NULL DEFAULT 60 CHECK (idle_timeout_minutes BETWEEN 5 AND 480),
  backup_dir           text NOT NULL DEFAULT '',
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES users (id),
  version              int NOT NULL DEFAULT 1,
  CONSTRAINT agency_logo_type CHECK ((logo IS NULL) = (logo_type IS NULL))
);

-- ---------------------------------------------------------------- application rights
GRANT USAGE ON SCHEMA public TO alyassir_app;
GRANT SELECT ON system_info, permissions, schema_migrations TO alyassir_app;
GRANT SELECT, INSERT, UPDATE ON sequences, users, sessions, message_threads, notifications, edit_requests TO alyassir_app;
-- Permission rows are switches; revoking one removes its row (the change is in the audit log).
GRANT SELECT, INSERT, DELETE ON user_permissions TO alyassir_app;
GRANT SELECT, INSERT ON audit_log, messages TO alyassir_app;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO alyassir_app;
GRANT SELECT, INSERT, UPDATE (read_at) ON message_recipients TO alyassir_app;
GRANT SELECT, UPDATE ON agency_settings TO alyassir_app;
