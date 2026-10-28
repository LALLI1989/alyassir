-- Phase 3: accounts (foundation), append-only ledger, instalments, debts, payments, receipts, jobs.
-- Amounts are integer cents (MAD). Nothing is deleted; money errors are corrected by reversal.

-- ---------------------------------------------------------------- accounts (SPEC 17.1, foundation)
CREATE TABLE accounts (
  code           text PRIMARY KEY CHECK (code IN ('drawer', 'safe', 'bank')),
  -- Fixed lock order (SPEC 4.5): drawer, safe, bank.
  lock_order     smallint NOT NULL UNIQUE,
  balance_cents  bigint NOT NULL DEFAULT 0,
  -- Only the bank may be allowed below zero, by the manager (Phase 4).
  allow_negative boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1,
  CONSTRAINT accounts_no_negative CHECK (allow_negative OR balance_cents >= 0),
  CONSTRAINT accounts_negative_bank_only CHECK (code = 'bank' OR NOT allow_negative)
);
INSERT INTO accounts (code, lock_order) VALUES ('drawer', 1), ('safe', 2), ('bank', 3);

-- ---------------------------------------------------------------- receipts (SPEC 14.8)
CREATE TABLE receipts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 2026-000001: one gap-free sequence per year (sequences table, row lock).
  number        text NOT NULL UNIQUE CHECK (number ~ '^\d{4}-\d{6,}$'),
  kind          text NOT NULL CHECK (kind IN ('payment', 'operation', 'refund')),
  status        text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'cancelled')),
  cancel_reason text,
  cancelled_at  timestamptz,
  cancelled_by  uuid REFERENCES users (id),
  policy_id     uuid REFERENCES policies (id),
  client_id     uuid REFERENCES clients (id),
  amount_cents  bigint NOT NULL,
  -- Frozen copy of everything printed: a receipt never changes after it is issued.
  snapshot      jsonb NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  issued_by     uuid REFERENCES users (id),
  is_historical boolean NOT NULL DEFAULT false,
  entered_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipts_cancel CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE INDEX receipts_policy ON receipts (policy_id, issued_at DESC);

-- ---------------------------------------------------------------- instalments (SPEC 14.4)
CREATE TABLE installment_plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id           uuid NOT NULL REFERENCES policies (id),
  period_id           uuid NOT NULL UNIQUE REFERENCES policy_periods (id),
  count               smallint NOT NULL CHECK (count BETWEEN 2 AND 4),
  premium_cents       bigint NOT NULL CHECK (premium_cents > 0),
  fee_per_instalment  bigint NOT NULL CHECK (fee_per_instalment >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES users (id)
);

CREATE TABLE installments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id          uuid NOT NULL REFERENCES installment_plans (id),
  policy_id        uuid NOT NULL REFERENCES policies (id),
  period_id        uuid NOT NULL REFERENCES policy_periods (id),
  seq              smallint NOT NULL CHECK (seq BETWEEN 1 AND 4),
  due_date         date NOT NULL,
  base_cents       bigint NOT NULL CHECK (base_cents >= 0),
  -- The instalment fee is part of the instalment (SPEC 14.4).
  fee_cents        bigint NOT NULL CHECK (fee_cents >= 0),
  -- base + fee, then + fees or price increases added later, - credits (SPEC 15).
  amount_cents     bigint NOT NULL CHECK (amount_cents >= 0),
  paid_cents       bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partial', 'paid', 'converted_to_debt', 'written_off')),
  converted_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,
  UNIQUE (plan_id, seq),
  CONSTRAINT installments_paid CHECK (paid_cents <= amount_cents)
);
CREATE INDEX installments_due ON installments (status, due_date);
CREATE INDEX installments_policy ON installments (policy_id);

-- ---------------------------------------------------------------- debts (SPEC 14.7)
CREATE TABLE debts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES clients (id),
  policy_id         uuid REFERENCES policies (id),
  period_id         uuid REFERENCES policy_periods (id),
  source            text NOT NULL CHECK (source IN ('direct', 'installment', 'rejected_payment', 'opening_balance', 'certificate_fee', 'price_increase')),
  installment_id    uuid REFERENCES installments (id),
  -- The day the debt arose (oldest first when paying).
  debt_date         date NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents >= 0),
  paid_cents        bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  -- Fallen with an annulment of an instalment policy (SPEC 13.1); the trace stays.
  written_off_cents bigint NOT NULL DEFAULT 0 CHECK (written_off_cents >= 0),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'written_off')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users (id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           int NOT NULL DEFAULT 1,
  CONSTRAINT debts_total CHECK (paid_cents + written_off_cents <= amount_cents),
  CONSTRAINT debts_installment CHECK ((source = 'installment') = (installment_id IS NOT NULL))
);
CREATE INDEX debts_client ON debts (client_id) WHERE status = 'open';
CREATE INDEX debts_policy ON debts (policy_id);
CREATE UNIQUE INDEX debts_one_per_installment ON debts (installment_id) WHERE installment_id IS NOT NULL;

-- ---------------------------------------------------------------- payments (SPEC 14.1, 14.2)
CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Set for payments recorded on their own (one key per click). Payments made inside another
  -- operation are protected by that operation's key.
  idempotency_key uuid UNIQUE,
  request_hash    text,
  policy_id       uuid NOT NULL REFERENCES policies (id),
  period_id       uuid NOT NULL REFERENCES policy_periods (id),
  client_id       uuid NOT NULL REFERENCES clients (id),
  operation_id    uuid REFERENCES policy_operations (id),
  method          text NOT NULL CHECK (method IN ('cash', 'cheque', 'transfer', 'card')),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  -- cash: collected (drawer at once). Others: in_collection, then confirmed (bank) or rejected.
  status          text NOT NULL CHECK (status IN ('collected', 'in_collection', 'confirmed', 'rejected')),
  received_on     date NOT NULL,
  received_by     uuid REFERENCES users (id),
  confirmed_at    timestamptz,
  confirmed_by    uuid REFERENCES users (id),
  rejected_at     timestamptz,
  rejected_by     uuid REFERENCES users (id),
  reject_reason   text,
  receipt_id      uuid REFERENCES receipts (id),
  is_historical   boolean NOT NULL DEFAULT false,
  entered_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  CONSTRAINT payments_cash CHECK ((method = 'cash') = (status = 'collected')),
  CONSTRAINT payments_rejected CHECK ((status = 'rejected') = (rejected_at IS NOT NULL AND reject_reason IS NOT NULL))
);
CREATE INDEX payments_policy ON payments (policy_id, created_at DESC);
CREATE INDEX payments_in_collection ON payments (status) WHERE status = 'in_collection';

CREATE TABLE payment_allocations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id     uuid NOT NULL REFERENCES payments (id),
  installment_id uuid REFERENCES installments (id),
  debt_id        uuid REFERENCES debts (id),
  cents          bigint NOT NULL CHECK (cents > 0),
  CONSTRAINT payment_allocations_one_target CHECK ((installment_id IS NULL) <> (debt_id IS NULL))
);
CREATE INDEX payment_allocations_payment ON payment_allocations (payment_id);

CREATE TABLE cheque_details (
  payment_id  uuid PRIMARY KEY REFERENCES payments (id),
  number      text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  bank        text NOT NULL CHECK (length(bank) BETWEEN 1 AND 80),
  drawer_name text NOT NULL CHECK (length(drawer_name) BETWEEN 1 AND 150),
  due_date    date NOT NULL
);
CREATE INDEX cheque_details_due ON cheque_details (due_date);

CREATE TABLE transfer_details (
  payment_id    uuid PRIMARY KEY REFERENCES payments (id),
  reference     text NOT NULL CHECK (length(reference) BETWEEN 1 AND 60),
  bank          text NOT NULL CHECK (length(bank) BETWEEN 1 AND 80),
  transfer_date date NOT NULL
);

-- Money given back to a client (annulment, cancellation, price decrease, fleet removal).
CREATE TABLE refunds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id     uuid NOT NULL REFERENCES policies (id),
  period_id     uuid NOT NULL REFERENCES policy_periods (id),
  client_id     uuid NOT NULL REFERENCES clients (id),
  operation_id  uuid NOT NULL REFERENCES policy_operations (id),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  account_code  text NOT NULL REFERENCES accounts (code),
  receipt_id    uuid REFERENCES receipts (id),
  paid_by       uuid REFERENCES users (id),
  paid_at       timestamptz NOT NULL DEFAULT now(),
  is_historical boolean NOT NULL DEFAULT false,
  entered_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- ledger (append-only, SPEC 4.9, 17.1)
CREATE TABLE financial_transactions (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Movements of one operation share a group (a transfer = one out + one in, Phase 4).
  group_id                uuid NOT NULL,
  account_code            text NOT NULL REFERENCES accounts (code),
  amount_cents            bigint NOT NULL CHECK (amount_cents <> 0),
  kind                    text NOT NULL CHECK (kind IN ('payment_cash', 'payment_confirmed', 'payment_reversed', 'refund')),
  payment_id              uuid REFERENCES payments (id),
  refund_id               uuid REFERENCES refunds (id),
  operation_id            uuid REFERENCES policy_operations (id),
  reverses_transaction_id bigint UNIQUE REFERENCES financial_transactions (id),
  business_date           date NOT NULL,
  user_id                 uuid REFERENCES users (id),
  note                    text,
  is_historical           boolean NOT NULL DEFAULT false,
  entered_at              timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX financial_transactions_account ON financial_transactions (account_code, created_at DESC);
CREATE INDEX financial_transactions_group ON financial_transactions (group_id);
CREATE TRIGGER financial_transactions_no_update_delete BEFORE UPDATE OR DELETE ON financial_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER financial_transactions_no_truncate BEFORE TRUNCATE ON financial_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- scheduled jobs (SPEC 4.18)
CREATE TABLE job_runs (
  job         text NOT NULL,
  run_date    date NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (job, run_date)
);

-- ---------------------------------------------------------------- application rights (no DELETE)
GRANT SELECT, UPDATE (balance_cents, updated_at, version) ON accounts TO alyassir_app;
GRANT SELECT, INSERT ON financial_transactions, payment_allocations, cheque_details, transfer_details,
  installment_plans, refunds TO alyassir_app;
GRANT USAGE ON SEQUENCE financial_transactions_id_seq TO alyassir_app;
GRANT SELECT, INSERT, UPDATE ON installments, debts, payments, job_runs TO alyassir_app;
GRANT SELECT, INSERT, UPDATE (status, cancel_reason, cancelled_at, cancelled_by) ON receipts TO alyassir_app;
-- Only the premium of a plan changes (new total before any payment, SPEC 11.5 / 14.4).
GRANT UPDATE (premium_cents) ON installment_plans TO alyassir_app;

-- ---------------------------------------------------------------- periods saved before payments existed
-- Policies saved in Phase 2 had no payment step. Nothing was recorded as paid, so what is still in
-- force is owed in full: a direct debt, like an issue with nothing paid (SPEC 14.4). Phase 2 ran
-- only on test data; the owner checks this rule (Phase 3 report).
INSERT INTO debts (client_id, policy_id, period_id, source, debt_date, amount_cents, created_by)
SELECT p.client_id, pp.policy_id, pp.id, 'direct', pp.start_date, pp.total_amount_cents, pp.created_by
FROM policy_periods pp
JOIN policies p ON p.id = pp.policy_id
WHERE pp.validity_status = 'active';
UPDATE policy_periods SET collection_status = 'outstanding' WHERE validity_status = 'active';
