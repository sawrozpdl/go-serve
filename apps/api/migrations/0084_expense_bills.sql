-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0084 — Expense bills, and a record of what a machine guessed
--
-- expenses.receipt_url has existed since 0006, is in the DTO and in the create
-- body, and has never once been populated by any client. It is also the wrong
-- shape: a bare URL implies a public object, and a supplier invoice carries the
-- vendor's bank details and PAN number. It is left in place, unused, and this
-- table supersedes it.
--
-- A SEPARATE TABLE, AND MANY BILLS PER EXPENSE
--
-- A bill arrives as three photographs at least as often as one PDF: page one,
-- page two, the delivery note. A single column forces the operator to choose
-- which page is the real one, which is not a choice anybody should have to make
-- about evidence. staff_documents (0023) already proves the shape — private
-- key, authenticated proxy, audited reads — so this borrows it wholesale.
--
-- expense_id IS NULLABLE, AND THAT IS THE AWKWARD PART
--
-- The bill is uploaded from the NEW-expense form, before any expense row
-- exists. Returning a bare storage key would let a client claim any key it
-- could guess, so instead the row is created UNCLAIMED (expense_id NULL) and
-- CreateExpense claims it by id. RLS already confines that to the caller's own
-- tenant, so the worst a malicious client achieves is attaching its own cafe's
-- orphan to its own cafe's expense. Unclaimed rows are swept after a day — a
-- draft nobody saved is not evidence.
--
-- WHAT A MACHINE GUESSED, AND WHAT A HUMAN CHECKED
--
-- expenses.ai_suggested_fields lists only the fields a model proposed AND the
-- operator submitted UNCHANGED. A field the operator corrected, or typed over,
-- is absent. So an empty array on an expense that HAS a bill means a human
-- entered every figure themselves — which is the question an audit actually
-- asks, and the reason this is a list of keys rather than a boolean.
--
-- It is computed by the client, which is the only party that knows what was
-- edited, and is therefore an HONESTY RECORD, NOT A SECURITY CONTROL. Making it
-- authoritative would mean the server storing every suggestion it ever emitted
-- and diffing on save — a table and a round trip for a provenance hint. The
-- server does bound it: the array must be a subset of the four known keys.
--
-- ai_usage IS ITS OWN LEDGER, NOT insight_briefs
--
-- A brief row is a brief: it has a headline, a narrative and an email. Bill
-- reads have none of those and a very different volume. They also get their own
-- monthly ceiling rather than sharing the insight budget: one shared cap means
-- a busy month of bill-reading silently killing every cafe's weekly wrap, and a
-- feature starving an unrelated feature is a worse failure than two numbers to
-- configure. The PRICE table is shared, so both ledgers value a token alike.
--
-- NOT IN THIS CHANGE, deliberately: presigned direct-to-storage uploads (there
-- are none anywhere in this repo and a bill is at most 10 MB), OCR of line
-- items into inventory rows, and any path by which an extraction writes an
-- expense by itself.
-- =========================================================================

CREATE TABLE IF NOT EXISTS expense_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- NULL = uploaded but not yet attached to a saved expense. See header.
  expense_id          uuid REFERENCES expenses(id) ON DELETE CASCADE,
  storage_key         text NOT NULL,             -- private object key, never a public URL
  file_name           text NOT NULL DEFAULT '',
  mime_type           text NOT NULL,
  size_bytes          bigint NOT NULL DEFAULT 0,
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE INDEX IF NOT EXISTS expense_documents_expense_idx
  ON expense_documents(tenant_id, expense_id) WHERE deleted_at IS NULL;
-- Drives the orphan sweep.
CREATE INDEX IF NOT EXISTS expense_documents_unclaimed_idx
  ON expense_documents(tenant_id, created_at)
  WHERE expense_id IS NULL AND deleted_at IS NULL;

ALTER TABLE expense_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expense_documents_isolation ON expense_documents;
CREATE POLICY expense_documents_isolation ON expense_documents
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON expense_documents TO app;

-- One row per model call. Ledger AND ceiling: the monthly cap is read from here.
CREATE TABLE IF NOT EXISTS ai_usage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purpose       text NOT NULL CHECK (purpose IN ('bill_read')),
  model         text NOT NULL,
  input_tokens  int  NOT NULL DEFAULT 0,
  output_tokens int  NOT NULL DEFAULT 0,
  -- USD × 1e6, integer for the reason insight_briefs.cost_micros is: a float
  -- sum of thousands of tiny charges drifts.
  cost_micros   bigint NOT NULL DEFAULT 0,
  -- A rejection is the verifier doing its job and is recorded separately from
  -- an outage, exactly as the weekly wrap does.
  status        text NOT NULL CHECK (status IN ('ok', 'rejected', 'error')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_month_idx ON ai_usage(tenant_id, purpose, created_at);

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_usage_isolation ON ai_usage;
CREATE POLICY ai_usage_isolation ON ai_usage
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON ai_usage TO app;

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS ai_suggested_fields text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ai_model text NOT NULL DEFAULT '';

COMMENT ON COLUMN expenses.ai_suggested_fields IS
  'Fields a model proposed AND the operator submitted unchanged. Subset of '
  '{vendor, amount_cents, paid_at, reference}, enforced in the handler. Empty '
  'on an expense that has a bill = a human entered every figure. '
  'Client-computed: an honesty record, not a security control. See 0084.';

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE expenses DROP COLUMN IF EXISTS ai_model, DROP COLUMN IF EXISTS ai_suggested_fields;
DROP TABLE IF EXISTS ai_usage;
DROP TABLE IF EXISTS expense_documents;
-- +goose StatementEnd
