-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- PAYMENTS
--
-- Append-only ledger of money received against an order. Multiple rows
-- per order = split payment. shift_id is nullable until M10 wires shifts
-- (then any cash payment recorded outside an open shift will fail).
-- =========================================================================

-- 'house_tab' settles to a stakeholder ledger (created in 0007 alongside
-- shifts) instead of taking cash today. 'other' is the catch-all for
-- bank transfers / online wallets we don't model individually.
CREATE TYPE payment_method AS ENUM ('cash', 'esewa', 'khalti', 'card', 'other', 'house_tab');

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shift_id            uuid, -- M10 will add the FK + constraint
  method              payment_method NOT NULL,
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  reference_no        text NOT NULL DEFAULT '',
  recorded_by_user_id uuid NOT NULL REFERENCES users(id),
  recorded_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payments_order_idx ON payments(order_id);
CREATE INDEX payments_tenant_recorded_idx ON payments(tenant_id, recorded_at DESC);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY payments_isolation ON payments
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- DELETE allows undoing a wrong-method / overpaid entry on an open
-- order before close (only handler that uses it).
GRANT SELECT, INSERT, DELETE ON payments TO app;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS payments CASCADE;
DROP TYPE  IF EXISTS payment_method;
-- +goose StatementEnd
