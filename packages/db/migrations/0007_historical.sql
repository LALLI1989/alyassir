-- Phase 7: historical entry mode (SPEC 22, owner decisions 29/10/2026 in SPEC 30). The agency's
-- first day is 01/05/2026; the manager enters everything since then with its real date, as if the
-- program had been running; live work starts when he presses "all old entries are done".
-- "pending": the question "do you have old policies?" is not answered yet.

-- ---------------------------------------------------------------- mode
ALTER TABLE system_info DROP CONSTRAINT system_info_historical_mode_check;
ALTER TABLE system_info ADD CONSTRAINT system_info_historical_mode_check CHECK (historical_mode IN ('pending', 'open', 'locked'));
ALTER TABLE system_info ALTER COLUMN historical_mode SET DEFAULT 'pending';
ALTER TABLE system_info ADD CONSTRAINT system_info_go_live CHECK ((historical_mode = 'locked') = (go_live_at IS NOT NULL));
-- A server that already holds real work stays live; an empty one asks the question.
UPDATE system_info SET
  historical_mode = CASE WHEN EXISTS (SELECT 1 FROM policies) OR EXISTS (SELECT 1 FROM financial_transactions) THEN 'locked' ELSE 'pending' END,
  go_live_at = CASE WHEN EXISTS (SELECT 1 FROM policies) OR EXISTS (SELECT 1 FROM financial_transactions) THEN coalesce(go_live_at, now()) ELSE NULL END;

-- ---------------------------------------------------------------- ledger: opening balances and corrections
ALTER TABLE financial_transactions DROP CONSTRAINT financial_transactions_kind_check;
ALTER TABLE financial_transactions ADD CONSTRAINT financial_transactions_kind_check CHECK (kind IN (
  'payment_cash', 'payment_confirmed', 'payment_reversed', 'refund',
  'transfer_out', 'transfer_in', 'expense', 'expense_reversed', 'insurer_payment', 'bank_withdrawal', 'reversal', 'count_adjustment',
  'opening_balance', 'balance_correction'));

-- No negative balance, except while the old entries are typed (they are checked day by day at
-- the end, SPEC 22). A CHECK cannot read system_info, so a trigger keeps the same rule.
ALTER TABLE accounts DROP CONSTRAINT accounts_no_negative;
CREATE FUNCTION accounts_no_negative() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.allow_negative AND NEW.balance_cents < 0
     AND coalesce((SELECT historical_mode FROM system_info LIMIT 1), 'locked') = 'locked' THEN
    RAISE EXCEPTION 'accounts_no_negative: account % would go below zero', NEW.code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_no_negative BEFORE INSERT OR UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_no_negative();

-- ---------------------------------------------------------------- marks
-- Instalments typed by hand with their old amounts, fees or dates (historical entry only).
ALTER TABLE installments ADD COLUMN manual boolean NOT NULL DEFAULT false;
ALTER TABLE policy_periods ADD COLUMN is_historical boolean NOT NULL DEFAULT false;
ALTER TABLE claims ADD COLUMN is_historical boolean NOT NULL DEFAULT false;
ALTER TABLE transfers ADD COLUMN is_historical boolean NOT NULL DEFAULT false;
ALTER TABLE debts ADD COLUMN is_historical boolean NOT NULL DEFAULT false;
-- A policy entered after going live with an old date, by the manager, with a reason.
ALTER TABLE policy_operations ADD COLUMN late_entry_reason text
  CHECK (late_entry_reason IS NULL OR length(late_entry_reason) BETWEEN 3 AND 500);

GRANT UPDATE (historical_mode, go_live_at) ON system_info TO alyassir_app;
