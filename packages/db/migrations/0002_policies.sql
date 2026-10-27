-- Phase 2: insurance settings, clients, vehicles, fleets, policies, periods, certificates, operations.
-- Runs as the database owner. Amounts are integer cents (MAD); business dates are "date" (no time).
-- Nothing is ever deleted: records are archived, cancelled or annulled, and the trace stays.

-- Partial name search on clients (SPEC 9.1, 25). A trusted extension: the database owner may add it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The certificate fee (17 MAD) is a setting (SPEC 25), used by Phase 3 to collect it.
ALTER TABLE agency_settings
  ADD COLUMN certificate_fee_cents bigint NOT NULL DEFAULT 1700 CHECK (certificate_fee_cents >= 0);

-- ---------------------------------------------------------------- insurance settings (SPEC 10)
CREATE TABLE insurers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at timestamptz
);
CREATE UNIQUE INDEX insurers_name_unique ON insurers (lower(name));
INSERT INTO insurers (name) VALUES ('RMA');

CREATE TABLE insurance_types (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insurer_id       uuid NOT NULL REFERENCES insurers (id),
  name_ar          text NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_fr          text NOT NULL CHECK (length(name_fr) BETWEEN 1 AND 120),
  requires_vehicle boolean NOT NULL,
  supports_fleet   boolean NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at      timestamptz,
  CONSTRAINT insurance_types_fleet_needs_vehicle CHECK (requires_vehicle OR NOT supports_fleet)
);
CREATE INDEX insurance_types_insurer ON insurance_types (insurer_id);

CREATE TABLE coverage_durations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  months      int NOT NULL UNIQUE CHECK (months BETWEEN 1 AND 60),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at timestamptz
);
INSERT INTO coverage_durations (months) VALUES (1), (3), (6), (12);

-- Built-in operation types (SPEC 11.4); the manager may add others (code custom_...).
CREATE TABLE operation_types (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z0-9_]{3,40}$'),
  name_ar     text NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_fr     text NOT NULL CHECK (length(name_fr) BETWEEN 1 AND 120),
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at timestamptz
);
INSERT INTO operation_types (code, name_ar, name_fr, is_system) VALUES
  ('new_issue', 'إصدار جديد', 'Nouvelle souscription', true),
  ('renewal', 'تجديد', 'Renouvellement', true),
  ('policy_change', 'تغيير بوليصة', 'Changement de police', true),
  ('vehicle_change', 'تغيير مركبة', 'Changement de véhicule', true),
  ('plate_change', 'تغيير الترقيم', 'Changement d''immatriculation', true),
  ('annulment', 'فسخ', 'Annulation', true),
  ('cancellation', 'إلغاء', 'Résiliation', true),
  ('duplicate', 'نسخة بديلة', 'Duplicata', true),
  ('fleet_add_vehicle', 'إضافة مركبة إلى الأسطول', 'Ajout d''un véhicule à la flotte', true),
  ('fleet_remove_vehicle', 'إزالة مركبة من الأسطول', 'Retrait d''un véhicule de la flotte', true);

-- ---------------------------------------------------------------- clients (SPEC 9.1)
CREATE TABLE clients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('individual', 'company', 'foreign')),
  full_name     text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 150),
  company_name  text CHECK (company_name IS NULL OR length(company_name) BETWEEN 1 AND 150),
  id_type       text NOT NULL CHECK (id_type IN ('cin', 'rc_ice', 'passport', 'residence_card')),
  -- As typed (trimmed), and normalised: spaces removed, capital letters.
  id_number     text NOT NULL CHECK (length(id_number) BETWEEN 1 AND 30),
  id_normalized text NOT NULL CHECK (id_normalized ~ '^[A-Z0-9]{1,20}$'),
  residency     text CHECK (residency IN ('resident', 'non_resident')),
  phone         text NOT NULL CHECK (length(phone) BETWEEN 6 AND 20),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at   timestamptz,
  CONSTRAINT clients_id_type_kind CHECK (
    (kind = 'individual' AND id_type = 'cin')
    OR (kind = 'company' AND id_type = 'rc_ice')
    OR (kind = 'foreign' AND id_type IN ('passport', 'residence_card'))
  ),
  CONSTRAINT clients_residency CHECK ((kind = 'foreign') = (residency IS NOT NULL)),
  CONSTRAINT clients_company_name CHECK (kind = 'company' OR company_name IS NULL)
);
-- One client per identity document, never merged (SPEC 9.1).
CREATE UNIQUE INDEX clients_identity_unique ON clients (id_type, id_normalized);
CREATE INDEX clients_name_search ON clients USING gin (full_name gin_trgm_ops);
CREATE INDEX clients_company_search ON clients USING gin (company_name gin_trgm_ops);
CREATE INDEX clients_phone ON clients (phone);
CREATE INDEX clients_id_search ON clients (id_normalized);

-- ---------------------------------------------------------------- vehicles (SPEC 9.2)
CREATE TABLE vehicles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients (id),
  plate_type       text NOT NULL CHECK (plate_type IN ('ma', 'ww', 'foreign', 'state')),
  plate            text NOT NULL CHECK (length(plate) BETWEEN 2 AND 20),
  -- Dashes and spaces removed, capitals: no two vehicles with the same plate, whatever the type.
  plate_normalized text NOT NULL CHECK (plate_normalized ~ '^[A-Z0-9]{2,15}$'),
  fiscal_power     smallint NOT NULL CHECK (fiscal_power BETWEEN 1 AND 99),
  fuel             text NOT NULL CHECK (fuel IN ('petrol', 'diesel', 'electric', 'hybrid', 'lpg')),
  brand            text NOT NULL CHECK (length(brand) BETWEEN 1 AND 60),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users (id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at      timestamptz
);
CREATE UNIQUE INDEX vehicles_plate_unique ON vehicles (plate_normalized);
CREATE INDEX vehicles_client ON vehicles (client_id);

-- ---------------------------------------------------------------- fleets (SPEC 9.3)
CREATE TABLE fleets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients (id),
  name        text NOT NULL DEFAULT '' CHECK (length(name) <= 100),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at timestamptz
);
CREATE INDEX fleets_client ON fleets (client_id);

-- Which vehicles belong to the fleet, and since when (removed_on: the day it left).
CREATE TABLE fleet_vehicles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id   uuid NOT NULL REFERENCES fleets (id),
  vehicle_id uuid NOT NULL REFERENCES vehicles (id),
  added_on   date NOT NULL,
  added_by   uuid REFERENCES users (id),
  removed_on date,
  removed_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fleet_vehicles_dates CHECK (removed_on IS NULL OR removed_on >= added_on)
);
CREATE UNIQUE INDEX fleet_vehicles_current ON fleet_vehicles (fleet_id, vehicle_id) WHERE removed_on IS NULL;
CREATE INDEX fleet_vehicles_vehicle ON fleet_vehicles (vehicle_id);

-- ---------------------------------------------------------------- policies (SPEC 11, 12)
CREATE TABLE policies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insurer_id         uuid NOT NULL REFERENCES insurers (id),
  -- Issued by the insurer, typed by hand, required; unique within one insurer.
  policy_number      text NOT NULL CHECK (length(policy_number) BETWEEN 1 AND 40),
  number_normalized  text NOT NULL CHECK (length(number_normalized) BETWEEN 1 AND 40),
  client_id          uuid NOT NULL REFERENCES clients (id),
  insurance_type_id  uuid NOT NULL REFERENCES insurance_types (id),
  fleet_id           uuid REFERENCES fleets (id),
  -- Policy change (from E+2): the new policy points to the one it replaces, once only.
  replaces_policy_id uuid UNIQUE REFERENCES policies (id),
  origin             text NOT NULL CHECK (origin IN ('new_issue', 'policy_change')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users (id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            int NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at        timestamptz,
  CONSTRAINT policies_change_has_origin CHECK ((origin = 'policy_change') = (replaces_policy_id IS NOT NULL))
);
CREATE UNIQUE INDEX policies_number_unique ON policies (insurer_id, number_normalized);
CREATE INDEX policies_client ON policies (client_id);
CREATE INDEX policies_number_search ON policies (number_normalized);

-- One row per coverage period: the issue, then each renewal (same number), linked in a chain.
CREATE TABLE policy_periods (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id            uuid NOT NULL REFERENCES policies (id),
  seq                  int NOT NULL CHECK (seq >= 1),
  previous_period_id   uuid REFERENCES policy_periods (id),
  operation            text NOT NULL CHECK (operation IN ('new_issue', 'renewal', 'policy_change')),
  start_date           date NOT NULL,
  end_date             date NOT NULL,
  coverage_duration_id uuid REFERENCES coverage_durations (id),
  months               int CHECK (months BETWEEN 1 AND 60),
  total_amount_cents   bigint NOT NULL CHECK (total_amount_cents > 0),
  -- Two independent statuses (SPEC 11.3). "expired" is not stored: it follows from end_date.
  validity_status      text NOT NULL DEFAULT 'active' CHECK (validity_status IN ('active', 'annulled', 'cancelled')),
  -- Filled from Phase 3 (payments). NULL: no payment information yet.
  collection_status    text CHECK (collection_status IN ('paid', 'in_collection', 'outstanding', 'payment_rejected')),
  status_changed_at    timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users (id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              int NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT policy_periods_dates CHECK (end_date >= start_date),
  CONSTRAINT policy_periods_chain CHECK ((seq = 1) = (previous_period_id IS NULL)),
  UNIQUE (policy_id, seq)
);
CREATE INDEX policy_periods_end ON policy_periods (end_date, validity_status);
CREATE INDEX policy_periods_policy ON policy_periods (policy_id, seq DESC);

-- Certificate numbers: typed by hand, unique within the insurer, never reused (SPEC 11.2).
-- Rows are never changed or removed (trigger below), so a number can never come back.
CREATE TABLE certificates (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insurer_id              uuid NOT NULL REFERENCES insurers (id),
  number                  text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  number_normalized       text NOT NULL CHECK (length(number_normalized) BETWEEN 1 AND 40),
  policy_id               uuid NOT NULL REFERENCES policies (id),
  period_id               uuid NOT NULL REFERENCES policy_periods (id),
  vehicle_id              uuid NOT NULL REFERENCES vehicles (id),
  issued_on               date NOT NULL,
  reason                  text NOT NULL CHECK (reason IN ('new_issue', 'renewal', 'policy_change', 'vehicle_change', 'plate_change', 'duplicate', 'fleet_add_vehicle')),
  replaces_certificate_id uuid REFERENCES certificates (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid REFERENCES users (id)
);
CREATE UNIQUE INDEX certificates_number_unique ON certificates (insurer_id, number_normalized);
CREATE INDEX certificates_number_search ON certificates (number_normalized);
CREATE INDEX certificates_vehicle ON certificates (vehicle_id);
CREATE TRIGGER certificates_no_update_delete BEFORE UPDATE OR DELETE ON certificates
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER certificates_no_truncate BEFORE TRUNCATE ON certificates
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- Policy operations (SPEC 11.4): the history of everything done to a policy. Amounts recorded now
-- are settled in Phase 3 (settlement_status: the only column that may change afterwards).
CREATE TABLE policy_operations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id              uuid NOT NULL REFERENCES policies (id),
  period_id              uuid NOT NULL REFERENCES policy_periods (id),
  operation_type         text NOT NULL REFERENCES operation_types (code),
  op_date                date NOT NULL,
  performed_by           uuid REFERENCES users (id),
  reason                 text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  details                jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_difference_cents bigint,
  fee_cents              bigint CHECK (fee_cents IS NULL OR fee_cents >= 0),
  -- difference + fee: > 0 the client pays, < 0 the client receives.
  net_cents              bigint,
  settlement_status      text NOT NULL DEFAULT 'none' CHECK (settlement_status IN ('none', 'pending', 'settled')),
  paper_receipt_no       text CHECK (paper_receipt_no IS NULL OR length(paper_receipt_no) BETWEEN 1 AND 40),
  -- One key per click (SPEC 4.6); request_hash detects a key reused for another request.
  idempotency_key        uuid NOT NULL UNIQUE,
  request_hash           text NOT NULL,
  is_historical          boolean NOT NULL DEFAULT false,
  entered_at             timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT policy_operations_net CHECK (
    net_cents IS NULL OR (fee_cents IS NOT NULL AND net_cents = coalesce(price_difference_cents, 0) + fee_cents)
  ),
  CONSTRAINT policy_operations_settlement CHECK (settlement_status = 'none' OR net_cents IS NOT NULL)
);
CREATE INDEX policy_operations_policy ON policy_operations (policy_id, created_at DESC);
CREATE INDEX policy_operations_pending ON policy_operations (settlement_status) WHERE settlement_status = 'pending';

-- Which vehicle is covered by which period, with its current certificate (SPEC 15).
CREATE TABLE period_vehicles (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id            uuid NOT NULL REFERENCES policy_periods (id),
  vehicle_id           uuid NOT NULL REFERENCES vehicles (id),
  certificate_id       uuid NOT NULL REFERENCES certificates (id),
  from_date            date NOT NULL,
  removed_on           date,
  removed_by_operation uuid REFERENCES policy_operations (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT period_vehicles_dates CHECK (removed_on IS NULL OR removed_on >= from_date),
  CONSTRAINT period_vehicles_removal CHECK ((removed_on IS NULL) = (removed_by_operation IS NULL))
);
CREATE UNIQUE INDEX period_vehicles_current ON period_vehicles (period_id, vehicle_id) WHERE removed_on IS NULL;
CREATE INDEX period_vehicles_vehicle ON period_vehicles (vehicle_id) WHERE removed_on IS NULL;

-- Old plates stay visible (SPEC 9.2); the operation is set when it was a policy operation.
CREATE TABLE vehicle_plate_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id     uuid NOT NULL REFERENCES vehicles (id),
  old_plate_type text NOT NULL CHECK (old_plate_type IN ('ma', 'ww', 'foreign', 'state')),
  old_plate      text NOT NULL,
  new_plate_type text NOT NULL CHECK (new_plate_type IN ('ma', 'ww', 'foreign', 'state')),
  new_plate      text NOT NULL,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  changed_by     uuid REFERENCES users (id),
  reason         text,
  operation_id   uuid REFERENCES policy_operations (id)
);
CREATE INDEX vehicle_plate_history_vehicle ON vehicle_plate_history (vehicle_id, changed_at DESC);
CREATE TRIGGER vehicle_plate_history_no_update_delete BEFORE UPDATE OR DELETE ON vehicle_plate_history
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER vehicle_plate_history_no_truncate BEFORE TRUNCATE ON vehicle_plate_history
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- application rights (no DELETE anywhere)
GRANT SELECT, INSERT, UPDATE ON insurers, insurance_types, coverage_durations, operation_types,
  clients, vehicles, fleets, policies, policy_periods TO alyassir_app;
GRANT SELECT, INSERT ON certificates, vehicle_plate_history TO alyassir_app;
GRANT SELECT, INSERT, UPDATE (removed_on, removed_by) ON fleet_vehicles TO alyassir_app;
GRANT SELECT, INSERT, UPDATE (certificate_id, removed_on, removed_by_operation) ON period_vehicles TO alyassir_app;
GRANT SELECT, INSERT, UPDATE (settlement_status) ON policy_operations TO alyassir_app;
