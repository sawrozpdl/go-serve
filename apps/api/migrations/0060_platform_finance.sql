-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0060 — The platform's own books.
--
-- tenant_payments (0039) records that a cafe paid, but not who physically
-- took the money. With cash collected in person by whoever visits the cafe,
-- "we're owed nothing, every cafe has paid" and "there is NPR 40,000 sitting
-- in somebody's bag" are both true at once, and only the first was visible.
--
-- Three additions:
--
--   1. WHO collected, and into what. Two columns on tenant_payments.
--
--   2. platform_expenses — what the platform spends. Deliberately mirrors the
--      tenant-side expenses table's shape (0014/0034): one enum-ish column
--      naming the funding source, and a single table-level CHECK that makes
--      every illegal column combination unrepresentable.
--
--   3. platform_cash_entries — a CLEARING LEDGER for cash in people's hands,
--      modelled directly on owner_cash_entries (0034). The key property, worth
--      restating because it's the thing that makes the model correct: a
--      collection does NOT create money. It moves money from "owed by a cafe"
--      into "held by a person". Depositing it to the bank moves it again. The
--      holding is never stored — always summed from the ledger — so it cannot
--      drift from its own history.
--
-- A collection row is written by the SAME transaction that records the
-- payment, and a unique index on payment_id enforces exactly one. That's what
-- makes the custody ledger structurally incapable of disagreeing with the
-- revenue ledger.
--
-- Commission is still NOT modelled. But platform_commissions(person_id,
-- tenant_id, payment_id, …) now joins cleanly against platform_people,
-- tenants.onboarded_by_person_id and tenant_payments.collected_by_person_id,
-- so it stays a pure addition whenever it's wanted.
-- =========================================================================

-- 1. Who took the money, and into what --------------------------------------

ALTER TABLE tenant_payments
  ADD COLUMN collected_by_person_id uuid REFERENCES platform_people(id) ON DELETE SET NULL,
  ADD COLUMN received_into text NOT NULL DEFAULT 'bank'
             CHECK (received_into IN ('cash', 'bank', 'wallet'));

CREATE INDEX tenant_payments_collector_idx
  ON tenant_payments (collected_by_person_id, created_at DESC)
  WHERE collected_by_person_id IS NOT NULL;

-- Backfill from what we already know. `method` has always recorded HOW the
-- money arrived, which maps cleanly onto the new destination column.
UPDATE tenant_payments SET received_into = CASE method
  WHEN 'cash'   THEN 'cash'
  WHEN 'online' THEN 'wallet'
  ELSE 'bank'
END;

-- recorded_by is the admin who typed it in — the closest thing to a collector
-- we have historically. Only where that admin has a registry row.
UPDATE tenant_payments tp
SET collected_by_person_id = pp.id
FROM platform_people pp
WHERE pp.user_id = tp.recorded_by AND tp.collected_by_person_id IS NULL;

-- NOTE: tenant_payments keeps its narrow GRANT SELECT, INSERT (0039). The new
-- columns are set at INSERT time; a correction is a reversing entry, not a
-- rewrite of history. Do not widen this.

-- 2. Platform expenses -------------------------------------------------------

CREATE TABLE platform_expense_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  icon       text NOT NULL DEFAULT '',
  sort_order int  NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_expense_categories_name_uniq
  ON platform_expense_categories (lower(name));

INSERT INTO platform_expense_categories (name, icon, sort_order) VALUES
  ('Hosting & infrastructure', 'server',    10),
  ('Software & tools',         'app-window', 20),
  ('Travel & field visits',    'car',       30),
  ('Marketing',                'megaphone', 40),
  ('Salaries & contractors',   'users',     50),
  ('Hardware',                 'printer',   60),
  ('Other',                    'ellipsis',  99)
ON CONFLICT DO NOTHING;

CREATE TABLE platform_expenses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id  uuid REFERENCES platform_expense_categories(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency     text NOT NULL DEFAULT 'NPR',
  occurred_on  date NOT NULL,
  vendor       text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  -- Where the money came from. 'person_cash' means somebody spent collected
  -- cash they were holding, which draws their custody balance down.
  paid_from    text NOT NULL CHECK (paid_from IN ('bank', 'wallet', 'person_cash')),
  paid_by_person_id uuid REFERENCES platform_people(id) ON DELETE RESTRICT,
  -- Optional attribution: a printer bought for one cafe, a trip to visit them.
  tenant_id    uuid REFERENCES tenants(id) ON DELETE SET NULL,
  recorded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  -- The single CHECK that makes the illegal states unrepresentable: a
  -- person-cash expense MUST name the person, and no other kind may.
  CONSTRAINT platform_expenses_paid_from_valid
    CHECK ((paid_from = 'person_cash') = (paid_by_person_id IS NOT NULL))
);
CREATE INDEX platform_expenses_date_idx
  ON platform_expenses (occurred_on DESC) WHERE deleted_at IS NULL;
CREATE INDEX platform_expenses_tenant_idx
  ON platform_expenses (tenant_id) WHERE tenant_id IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER platform_expenses_updated_at
  BEFORE UPDATE ON platform_expenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Cash custody clearing ledger --------------------------------------------

CREATE TYPE platform_cash_kind AS ENUM (
  'collection',      -- a cafe paid cash into a person's hands   (+holding)
  'deposit_to_bank', -- that person banked it                    (-holding)
  'expense',         -- they spent it on a platform expense      (-holding)
  'handover_out',    -- they gave it to somebody else            (-holding)
  'handover_in'      -- …the receiving side of the same handover (+holding)
);

CREATE TABLE platform_cash_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id    uuid NOT NULL REFERENCES platform_people(id) ON DELETE RESTRICT,
  kind         platform_cash_kind NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  payment_id   uuid REFERENCES tenant_payments(id)   ON DELETE RESTRICT,
  expense_id   uuid REFERENCES platform_expenses(id) ON DELETE RESTRICT,
  counterparty_person_id uuid REFERENCES platform_people(id) ON DELETE RESTRICT,
  -- Pairs the two halves of a handover so they can be shown, and reversed,
  -- together.
  transfer_group_id uuid,
  reference_no text NOT NULL DEFAULT '',   -- deposit slip number, etc.
  notes        text NOT NULL DEFAULT '',
  recorded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Each kind carries exactly the link it needs, and no other.
  CONSTRAINT platform_cash_collection_link
    CHECK ((kind = 'collection') = (payment_id IS NOT NULL)),
  CONSTRAINT platform_cash_expense_link
    CHECK ((kind = 'expense') = (expense_id IS NOT NULL)),
  CONSTRAINT platform_cash_handover_link
    CHECK (kind NOT IN ('handover_out', 'handover_in')
           OR (counterparty_person_id IS NOT NULL AND transfer_group_id IS NOT NULL)),
  -- Nobody hands cash to themselves.
  CONSTRAINT platform_cash_no_self_handover
    CHECK (counterparty_person_id IS NULL OR counterparty_person_id <> person_id)
);

CREATE INDEX platform_cash_entries_person_idx
  ON platform_cash_entries (person_id, occurred_at DESC);
CREATE INDEX platform_cash_entries_group_idx
  ON platform_cash_entries (transfer_group_id) WHERE transfer_group_id IS NOT NULL;
-- One custody row per payment, ever. This is what makes it impossible for the
-- custody ledger to disagree with the revenue ledger.
CREATE UNIQUE INDEX platform_cash_entries_payment_uniq
  ON platform_cash_entries (payment_id) WHERE payment_id IS NOT NULL;

-- Append-only: a mistake is corrected with a reversing entry, not an edit.
GRANT SELECT, INSERT         ON platform_cash_entries        TO app;
GRANT SELECT, INSERT, UPDATE ON platform_expenses            TO app;
GRANT SELECT, INSERT, UPDATE ON platform_expense_categories  TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP TABLE IF EXISTS platform_cash_entries;
DROP TYPE  IF EXISTS platform_cash_kind;
DROP TABLE IF EXISTS platform_expenses;
DROP TABLE IF EXISTS platform_expense_categories;

DROP INDEX IF EXISTS tenant_payments_collector_idx;
ALTER TABLE tenant_payments
  DROP COLUMN IF EXISTS received_into,
  DROP COLUMN IF EXISTS collected_by_person_id;

-- +goose StatementEnd
