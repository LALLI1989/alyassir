-- Phase 5: claims, contact log, WhatsApp templates, reminder delays (SPEC 18). Owner decisions
-- 28/10/2026 (SPEC 30): the accident is inside the coverage and declared within 5 days (the manager
-- may record a late one with a reason); opening WhatsApp is written in the contact log.

-- ---------------------------------------------------------------- reminder delays (SPEC 18.2)
ALTER TABLE agency_settings
  ADD COLUMN remind_policy_days     int NOT NULL DEFAULT 30 CHECK (remind_policy_days BETWEEN 1 AND 120),
  ADD COLUMN remind_instalment_days int NOT NULL DEFAULT 3 CHECK (remind_instalment_days BETWEEN 0 AND 60),
  ADD COLUMN remind_cheque_days     int NOT NULL DEFAULT 3 CHECK (remind_cheque_days BETWEEN 0 AND 60),
  ADD COLUMN remind_claim_days      int NOT NULL DEFAULT 7 CHECK (remind_claim_days BETWEEN 1 AND 120);

-- ---------------------------------------------------------------- claims (SPEC 18.1): information only
CREATE TABLE claims (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES clients (id),
  policy_id           uuid NOT NULL REFERENCES policies (id),
  period_id           uuid NOT NULL REFERENCES policy_periods (id),
  -- Kept for uniqueness of the claim number at the same insurer.
  insurer_id          uuid NOT NULL REFERENCES insurers (id),
  claim_number        text CHECK (claim_number IS NULL OR length(claim_number) BETWEEN 1 AND 60),
  claim_number_normalized text GENERATED ALWAYS AS (upper(regexp_replace(claim_number, '\s+', '', 'g'))) STORED,
  accident_date       date NOT NULL,
  declared_on         date NOT NULL,
  place               text NOT NULL CHECK (length(place) BETWEEN 1 AND 200),
  description         text NOT NULL DEFAULT '',
  requested_cents     bigint CHECK (requested_cents >= 0),
  compensated_cents   bigint CHECK (compensated_cents >= 0),
  notes               text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'declared' CHECK (status IN ('declared', 'expertise', 'processing', 'closed', 'rejected')),
  -- A declaration after the 5 days, recorded by the manager with a reason.
  late_reason         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES users (id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES users (id),
  version             int NOT NULL DEFAULT 1,
  archived_at         timestamptz,
  CONSTRAINT claims_dates CHECK (declared_on >= accident_date)
);
CREATE UNIQUE INDEX claims_number_unique ON claims (insurer_id, claim_number_normalized) WHERE claim_number IS NOT NULL;
CREATE INDEX claims_client ON claims (client_id);
CREATE INDEX claims_policy ON claims (policy_id);
CREATE INDEX claims_open ON claims (status, updated_at) WHERE status NOT IN ('closed', 'rejected');

-- ---------------------------------------------------------------- contact log (SPEC 18.3): append-only
CREATE TABLE contact_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients (id),
  policy_id     uuid REFERENCES policies (id),
  kind          text NOT NULL CHECK (kind IN ('called', 'no_answer', 'promise', 'note', 'whatsapp')),
  promise_date  date,
  note          text NOT NULL DEFAULT '',
  -- For a WhatsApp line: which template, in which language.
  template_code text,
  language      text CHECK (language IN ('ar', 'fr')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL REFERENCES users (id),
  CONSTRAINT contact_logs_promise CHECK ((kind = 'promise') = (promise_date IS NOT NULL)),
  CONSTRAINT contact_logs_note CHECK (kind <> 'note' OR length(note) > 0),
  CONSTRAINT contact_logs_whatsapp CHECK ((kind = 'whatsapp') = (template_code IS NOT NULL AND language IS NOT NULL))
);
CREATE INDEX contact_logs_client ON contact_logs (client_id, created_at DESC);
CREATE INDEX contact_logs_promise ON contact_logs (promise_date) WHERE kind = 'promise';
CREATE TRIGGER contact_logs_no_update_delete BEFORE UPDATE OR DELETE ON contact_logs FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------- WhatsApp templates (SPEC 18.4)
CREATE TABLE whatsapp_templates (
  code       text PRIMARY KEY CHECK (code ~ '^[a-z_]{3,30}$'),
  body_ar    text NOT NULL CHECK (length(body_ar) BETWEEN 1 AND 1000),
  body_fr    text NOT NULL CHECK (length(body_fr) BETWEEN 1 AND 1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users (id),
  version    int NOT NULL DEFAULT 1
);
INSERT INTO whatsapp_templates (code, body_ar, body_fr) VALUES
  ('renewal',
   'السلام عليكم {client}، نذكّركم بأن بوليصتكم رقم {policy} للمركبة {plate} تنتهي يوم {end_date}. نرحب بكم لتجديدها.',
   'Bonjour {client}, votre police n° {policy} pour le véhicule {plate} expire le {end_date}. Nous restons à votre disposition pour son renouvellement.'),
  ('payment',
   'السلام عليكم {client}، نذكّركم بأن المبلغ المتبقي على بوليصتكم رقم {policy} هو {remaining}. شكرًا لكم.',
   'Bonjour {client}, il reste {remaining} à régler sur votre police n° {policy}. Merci.');

-- ---------------------------------------------------------------- application rights (no DELETE)
GRANT SELECT, INSERT, UPDATE ON claims TO alyassir_app;
GRANT SELECT, INSERT ON contact_logs TO alyassir_app;
GRANT SELECT, UPDATE (body_ar, body_fr, updated_at, updated_by, version) ON whatsapp_templates TO alyassir_app;
