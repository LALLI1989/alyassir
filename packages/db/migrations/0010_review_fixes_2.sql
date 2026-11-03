-- Review, second part (owner decisions of 03/11/2026 in SPEC 30).

-- ---------------------------------------------------------------- plates
-- "Another Moroccan" plate: a Moroccan plate that does not follow the normal shape 00123-B-01
-- (Latin letters and digits, free, unique like every plate after normalization).
ALTER TABLE vehicles DROP CONSTRAINT vehicles_plate_type_check;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_plate_type_check CHECK (plate_type IN ('ma', 'ma_other', 'ww', 'foreign', 'state'));
ALTER TABLE vehicle_plate_history DROP CONSTRAINT vehicle_plate_history_old_plate_type_check;
ALTER TABLE vehicle_plate_history ADD CONSTRAINT vehicle_plate_history_old_plate_type_check CHECK (old_plate_type IN ('ma', 'ma_other', 'ww', 'foreign', 'state'));
ALTER TABLE vehicle_plate_history DROP CONSTRAINT vehicle_plate_history_new_plate_type_check;
ALTER TABLE vehicle_plate_history ADD CONSTRAINT vehicle_plate_history_new_plate_type_check CHECK (new_plate_type IN ('ma', 'ma_other', 'ww', 'foreign', 'state'));

-- ---------------------------------------------------------------- a cash payment typed by mistake
-- The manager cancels it with a reason: its cash leaves the drawer, what it paid is owed again, its
-- receipt stays numbered as "cancelled". Nothing is deleted.
ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (status IN ('collected', 'in_collection', 'confirmed', 'rejected', 'cancelled'));
ALTER TABLE payments DROP CONSTRAINT payments_cash;
ALTER TABLE payments ADD CONSTRAINT payments_cash CHECK ((method = 'cash') = (status IN ('collected', 'cancelled')));
ALTER TABLE payments
  ADD COLUMN cancelled_at  timestamptz,
  ADD COLUMN cancelled_by  uuid REFERENCES users (id),
  ADD COLUMN cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 1 AND 1000);
ALTER TABLE payments ADD CONSTRAINT payments_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL));
