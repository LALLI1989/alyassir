-- Phase 4: drawer sessions and daily closing, expenses, transfers between accounts, payments to
-- insurers, bank withdrawals (SPEC 17). Owner decisions 28/10/2026 (SPEC 30): one shared drawer
-- session for everyone present; the day is closed by its last closing.

-- ---------------------------------------------------------------- drawer sessions (SPEC 17.3)
CREATE TABLE drawer_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at          timestamptz NOT NULL DEFAULT now(),
  opened_by          uuid NOT NULL REFERENCES users (id),
  -- Balance computed by the program when the first person received the drawer.
  opening_cents      bigint NOT NULL,
  closed_at          timestamptz,
  closed_by          uuid REFERENCES users (id),
  -- Closed by the manager or a supervisor who was not in the session (SPEC 17.3).
  closed_on_behalf   boolean NOT NULL DEFAULT false,
  business_date      date,
  expected_cents     bigint,
  counted_cents      bigint CHECK (counted_cents >= 0),
  difference_cents   bigint,
  close_reason       text,
  version            int NOT NULL DEFAULT 1,
  CONSTRAINT drawer_sessions_closed CHECK (
    (status = 'open' AND closed_at IS NULL AND counted_cents IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL AND business_date IS NOT NULL
        AND expected_cents IS NOT NULL AND counted_cents IS NOT NULL AND difference_cents = counted_cents - expected_cents
        AND (difference_cents = 0 OR length(coalesce(close_reason, '')) > 0))
  )
);
-- One drawer, so one open session at a time.
CREATE UNIQUE INDEX drawer_sessions_one_open ON drawer_sessions ((true)) WHERE status = 'open';
CREATE INDEX drawer_sessions_day ON drawer_sessions (business_date, closed_at);

-- Everyone who received the drawer in this session, with what they found.
CREATE TABLE drawer_session_members (
  session_id       uuid NOT NULL REFERENCES drawer_sessions (id),
  user_id          uuid NOT NULL REFERENCES users (id),
  joined_at        timestamptz NOT NULL DEFAULT now(),
  shown_cents      bigint NOT NULL,
  counted_cents    bigint NOT NULL CHECK (counted_cents >= 0),
  difference_cents bigint NOT NULL,
  reason           text,
  PRIMARY KEY (session_id, user_id),
  CONSTRAINT drawer_members_difference CHECK (difference_cents = counted_cents - shown_cents AND (difference_cents = 0 OR length(coalesce(reason, '')) > 0))
);
CREATE TRIGGER drawer_session_members_no_update_delete BEFORE UPDATE OR DELETE ON drawer_session_members
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Manager review of a day (SPEC 17.3): approval of what happened after the last closing, or reopening.
CREATE TABLE drawer_day_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date date NOT NULL,
  action        text NOT NULL CHECK (action IN ('approve', 'reopen')),
  reason        text,
  user_id       uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drawer_day_reviews_reason CHECK (action <> 'reopen' OR length(coalesce(reason, '')) > 0)
);
CREATE INDEX drawer_day_reviews_day ON drawer_day_reviews (business_date, created_at);
CREATE TRIGGER drawer_day_reviews_no_update_delete BEFORE UPDATE OR DELETE ON drawer_day_reviews
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- expenses (SPEC 17.2)
CREATE TABLE expense_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Default categories have a code translated by the interface; added ones one French name.
  code        text UNIQUE CHECK (code ~ '^[a-z_]{3,30}$'),
  name        text CHECK (length(name) BETWEEN 1 AND 80),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users (id),
  version     int NOT NULL DEFAULT 1,
  archived_at timestamptz,
  CONSTRAINT expense_categories_named CHECK ((code IS NULL) <> (name IS NULL))
);
CREATE UNIQUE INDEX expense_categories_name ON expense_categories (lower(name)) WHERE name IS NOT NULL;
INSERT INTO expense_categories (code) VALUES ('rent'), ('water'), ('electricity'), ('phone'), ('cleaning'), ('supplies'), ('travel');

CREATE TABLE expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key uuid NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  category_id     uuid NOT NULL REFERENCES expense_categories (id),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  expense_date    date NOT NULL,
  note            text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  -- Chosen by the manager when approving (the drawer by default).
  account_code    text REFERENCES accounts (code),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES users (id),
  session_id      uuid REFERENCES drawer_sessions (id),
  decided_at      timestamptz,
  decided_by      uuid REFERENCES users (id),
  reject_reason   text,
  cancelled_at    timestamptz,
  cancelled_by    uuid REFERENCES users (id),
  cancel_reason   text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  is_historical   boolean NOT NULL DEFAULT false,
  CONSTRAINT expenses_approved CHECK (status <> 'approved' OR account_code IS NOT NULL),
  CONSTRAINT expenses_rejected CHECK (status <> 'rejected' OR length(coalesce(reject_reason, '')) > 0),
  CONSTRAINT expenses_cancelled CHECK (status <> 'cancelled' OR length(coalesce(cancel_reason, '')) > 0)
);
CREATE INDEX expenses_status ON expenses (status, created_at DESC);

-- ---------------------------------------------------------------- money between accounts and out (SPEC 17.1, 17.4)
CREATE TABLE transfers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key uuid NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  from_account    text NOT NULL REFERENCES accounts (code),
  to_account      text NOT NULL REFERENCES accounts (code),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  business_date   date NOT NULL,
  reference       text NOT NULL DEFAULT '',
  -- A correction: this row reverses another (SPEC 17.4: no edit, a documented reverse movement).
  reverses_id     uuid UNIQUE REFERENCES transfers (id),
  reason          text,
  created_by      uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfers_accounts CHECK (from_account <> to_account),
  CONSTRAINT transfers_reversal CHECK (reverses_id IS NULL OR length(coalesce(reason, '')) > 0)
);

CREATE TABLE insurer_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key uuid NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  insurer_id      uuid NOT NULL REFERENCES insurers (id),
  account_code    text NOT NULL REFERENCES accounts (code),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  business_date   date NOT NULL,
  reference       text NOT NULL DEFAULT '',
  note            text NOT NULL DEFAULT '',
  reverses_id     uuid UNIQUE REFERENCES insurer_payments (id),
  reason          text,
  created_by      uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  is_historical   boolean NOT NULL DEFAULT false,
  CONSTRAINT insurer_payments_reversal CHECK (reverses_id IS NULL OR length(coalesce(reason, '')) > 0)
);

CREATE TABLE withdrawal_reasons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE CHECK (code ~ '^[a-z_]{3,30}$'),
  name        text CHECK (length(name) BETWEEN 1 AND 80),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users (id),
  version     int NOT NULL DEFAULT 1,
  archived_at timestamptz,
  CONSTRAINT withdrawal_reasons_named CHECK ((code IS NULL) <> (name IS NULL))
);
CREATE UNIQUE INDEX withdrawal_reasons_name ON withdrawal_reasons (lower(name)) WHERE name IS NOT NULL;
INSERT INTO withdrawal_reasons (code) VALUES ('profits'), ('personal'), ('advance'), ('cash_expense'), ('other');

CREATE TABLE bank_withdrawals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key uuid NOT NULL UNIQUE,
  request_hash    text NOT NULL,
  reason_id       uuid NOT NULL REFERENCES withdrawal_reasons (id),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  business_date   date NOT NULL,
  explanation     text NOT NULL CHECK (length(explanation) > 0),
  reference       text NOT NULL DEFAULT '',
  reverses_id     uuid UNIQUE REFERENCES bank_withdrawals (id),
  reason          text,
  created_by      uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  is_historical   boolean NOT NULL DEFAULT false,
  CONSTRAINT bank_withdrawals_reversal CHECK (reverses_id IS NULL OR length(coalesce(reason, '')) > 0)
);

CREATE TRIGGER transfers_no_update_delete BEFORE UPDATE OR DELETE ON transfers FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER insurer_payments_no_update_delete BEFORE UPDATE OR DELETE ON insurer_payments FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER bank_withdrawals_no_update_delete BEFORE UPDATE OR DELETE ON bank_withdrawals FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- ledger: new kinds and links
ALTER TABLE financial_transactions DROP CONSTRAINT financial_transactions_kind_check;
ALTER TABLE financial_transactions ADD CONSTRAINT financial_transactions_kind_check CHECK (kind IN (
  'payment_cash', 'payment_confirmed', 'payment_reversed', 'refund',
  'transfer_out', 'transfer_in', 'expense', 'expense_reversed', 'insurer_payment', 'bank_withdrawal', 'reversal'));
ALTER TABLE financial_transactions
  ADD COLUMN session_id         uuid REFERENCES drawer_sessions (id),
  ADD COLUMN expense_id         uuid REFERENCES expenses (id),
  ADD COLUMN transfer_id        uuid REFERENCES transfers (id),
  ADD COLUMN insurer_payment_id uuid REFERENCES insurer_payments (id),
  ADD COLUMN withdrawal_id      uuid REFERENCES bank_withdrawals (id);
CREATE INDEX financial_transactions_session ON financial_transactions (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX financial_transactions_day ON financial_transactions (account_code, business_date, created_at);

-- ---------------------------------------------------------------- application rights (no DELETE)
GRANT SELECT, INSERT, UPDATE ON drawer_sessions, expenses TO alyassir_app;
GRANT SELECT, INSERT ON drawer_session_members, drawer_day_reviews, transfers, insurer_payments, bank_withdrawals TO alyassir_app;
GRANT SELECT, INSERT, UPDATE (name, archived_at, version) ON expense_categories, withdrawal_reasons TO alyassir_app;
GRANT UPDATE (allow_negative) ON accounts TO alyassir_app;
