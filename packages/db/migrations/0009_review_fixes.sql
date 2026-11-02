-- Review of 02/11/2026 (owner decisions in SPEC 30). An expense waiting for approval already left
-- the drawer: a count does not take it out again, and when the manager rejects it the drawer goes
-- down by its amount (a "rejected expense" movement, linked to the expense, with the reason).
ALTER TABLE financial_transactions DROP CONSTRAINT financial_transactions_kind_check;
ALTER TABLE financial_transactions ADD CONSTRAINT financial_transactions_kind_check CHECK (kind IN (
  'payment_cash', 'payment_confirmed', 'payment_reversed', 'refund',
  'transfer_out', 'transfer_in', 'expense', 'expense_reversed', 'insurer_payment', 'bank_withdrawal', 'reversal', 'count_adjustment',
  'opening_balance', 'balance_correction', 'expense_rejected'));
