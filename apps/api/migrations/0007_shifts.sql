-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- SHIFTS  (cash drawer reconciliation)
--
-- One open shift per tenant at any time (partial unique index).
-- Cash payments only accepted while a shift is open. Closing the shift
-- counts the drawer, computes expected cash from the ledger, and records
-- any variance.
-- =========================================================================

CREATE TABLE shifts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  opened_by_user_id     uuid NOT NULL REFERENCES users(id),
  opened_at             timestamptz NOT NULL DEFAULT now(),
  opening_float_cents   bigint NOT NULL CHECK (opening_float_cents >= 0),
  closed_by_user_id     uuid REFERENCES users(id),
  closed_at             timestamptz,
  closing_count_cents   bigint CHECK (closing_count_cents IS NULL OR closing_count_cents >= 0),
  expected_cash_cents   bigint,
  variance_cents        bigint, -- closing_count - expected (negative = short)
  notes                 text NOT NULL DEFAULT ''
);

CREATE INDEX shifts_tenant_opened_idx ON shifts(tenant_id, opened_at DESC);
CREATE UNIQUE INDEX shifts_one_open_per_tenant
  ON shifts(tenant_id) WHERE closed_at IS NULL;

ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts FORCE ROW LEVEL SECURITY;
CREATE POLICY shifts_isolation ON shifts
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =========================================================================
-- HOUSE_TABS  (stakeholder credit ledger)
--
-- Named running ledgers for stakeholders (e.g. "Owner A", "Staff meal",
-- "Supplier loan"). Settling an order "to a tab" recognises revenue
-- normally but defers the cash receipt — a payments row is recorded with
-- method='house_tab' + house_tab_id. Settlements (paying the tab down)
-- live in house_tab_settlements. Balance = Σ tab payments − Σ settlements.
--
-- Lives here (not in 0004) because house_tab_settlements references
-- shifts(id), so the table has to be created after the shifts table above.
-- =========================================================================

CREATE TABLE house_tabs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  notes       text NOT NULL DEFAULT '',
  is_active   boolean NOT NULL DEFAULT true,
  created_by_user_id uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  deleted_at  timestamptz
);

CREATE INDEX house_tabs_tenant_idx ON house_tabs(tenant_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX house_tabs_tenant_name_uniq
  ON house_tabs(tenant_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TRIGGER house_tabs_updated_at BEFORE UPDATE ON house_tabs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE house_tabs ENABLE ROW LEVEL SECURITY;
ALTER TABLE house_tabs FORCE ROW LEVEL SECURITY;
CREATE POLICY house_tabs_isolation ON house_tabs
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE TABLE house_tab_settlements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  house_tab_id        uuid NOT NULL REFERENCES house_tabs(id) ON DELETE RESTRICT,
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  payment_method      payment_method NOT NULL,
  reference_no        text NOT NULL DEFAULT '',
  notes               text NOT NULL DEFAULT '',
  recorded_by_user_id uuid NOT NULL REFERENCES users(id),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  shift_id            uuid REFERENCES shifts(id)
);

CREATE INDEX house_tab_settlements_tab_idx
  ON house_tab_settlements(house_tab_id, recorded_at DESC);
CREATE INDEX house_tab_settlements_tenant_idx
  ON house_tab_settlements(tenant_id, recorded_at DESC);

ALTER TABLE house_tab_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE house_tab_settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY house_tab_settlements_isolation ON house_tab_settlements
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- =========================================================================
-- payments alters
-- shift_id FK: column already exists from 0004 (nullable). Add the FK now
-- that shifts exists.
-- house_tab_id: only set when method='house_tab'.
-- =========================================================================

ALTER TABLE payments
  ADD CONSTRAINT payments_shift_fk
  FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE RESTRICT;

CREATE INDEX payments_shift_idx ON payments(shift_id) WHERE shift_id IS NOT NULL;

ALTER TABLE payments
  ADD COLUMN house_tab_id uuid REFERENCES house_tabs(id) ON DELETE RESTRICT;

CREATE INDEX payments_house_tab_idx
  ON payments(house_tab_id) WHERE house_tab_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON shifts TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON house_tabs TO app;
GRANT SELECT, INSERT ON house_tab_settlements TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS house_tab_settlements CASCADE;
ALTER TABLE payments DROP COLUMN IF EXISTS house_tab_id;
DROP INDEX IF EXISTS payments_house_tab_idx;
DROP TABLE IF EXISTS house_tabs CASCADE;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_shift_fk;
DROP INDEX IF EXISTS payments_shift_idx;
DROP TABLE IF EXISTS shifts CASCADE;
-- +goose StatementEnd
