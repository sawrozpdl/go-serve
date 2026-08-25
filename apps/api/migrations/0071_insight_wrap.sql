-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0071 — the weekly wrap, and the model's ledger.
--
-- WHY A `kind` COLUMN RATHER THAN A SECOND TABLE
--
-- The wrap is the same artifact as the daily brief in every way that matters to
-- this schema: one per café per local day, reserved before the work, stamped
-- when the email goes. It differs in cadence and in tone, not in shape. A second
-- table would have duplicated the marker logic — which is the one piece of this
-- job that must not have two implementations, because it is what stops a café
-- being emailed twice.
--
-- So the uniqueness moves from (tenant, day) to (tenant, day, kind). A Monday
-- carries both rows: the daily brief and the wrap.
--
-- WHY THE LLM COLUMNS LIVE HERE
--
-- insight_briefs.cost_micros IS the spend ledger. There is no separate usage
-- table because there is nothing a separate table would answer that this one
-- cannot: the month's spend is a SUM over rows that already exist, and every
-- charge is already attached to the thing it paid for.
--
-- raw_response is populated in EXACTLY ONE CASE: llm_status = 'rejected_numbers',
-- meaning the verifier caught the model putting a figure in its prose. That is
-- the only time a model's output is worth a row — it is evidence about our own
-- prompt. Successful prose is stored as `narrative` because the café was
-- actually shown it; everything else is discarded.
--
-- The prompt itself is NEVER stored, only its sha256. The prompt contains a
-- café's business data, a hash is enough to tell whether two runs used the same
-- instruction, and the payload is reconstructible from insight_brief_items.
-- =========================================================================

ALTER TABLE insight_briefs
  -- 'daily' for the morning brief, 'weekly' for the Monday wrap. Existing rows
  -- are all daily.
  ADD COLUMN kind text NOT NULL DEFAULT 'daily'
    CHECK (kind IN ('daily', 'weekly')),

  -- The prose, when a model wrote it and the verifier accepted it. Empty means
  -- the deterministic text was used — which is the normal, expected state
  -- whenever no model is configured.
  ADD COLUMN headline  text NOT NULL DEFAULT '',
  ADD COLUMN narrative text NOT NULL DEFAULT '',

  -- Why the model's output was or was not used. 'disabled' is the default
  -- because that is the truth until somebody sets a key.
  ADD COLUMN llm_status text NOT NULL DEFAULT 'disabled'
    CHECK (llm_status IN ('ok', 'disabled', 'timeout', 'error', 'budget', 'rejected_numbers')),
  ADD COLUMN llm_model     text NOT NULL DEFAULT '',
  ADD COLUMN prompt_sha256 text NOT NULL DEFAULT '',
  -- Only ever set when llm_status = 'rejected_numbers'. Capped by the caller.
  ADD COLUMN raw_response  text NOT NULL DEFAULT '',

  ADD COLUMN input_tokens  int    NOT NULL DEFAULT 0,
  ADD COLUMN output_tokens int    NOT NULL DEFAULT 0,
  -- USD x 1e6. Integer so summing thousands of tiny charges cannot drift the
  -- way a float sum would.
  ADD COLUMN cost_micros   bigint NOT NULL DEFAULT 0;

-- A café gets one brief and one wrap per local day, not one row per day.
ALTER TABLE insight_briefs DROP CONSTRAINT insight_briefs_tenant_id_day_key;
ALTER TABLE insight_briefs
  ADD CONSTRAINT insight_briefs_tenant_day_kind_key UNIQUE (tenant_id, day, kind);

-- The month's spend, which is what the budget check reads. Partial: only rows
-- that actually cost something are worth an index entry, and on a café that
-- never enables a model that is all of them.
CREATE INDEX insight_briefs_spend_idx
  ON insight_briefs (created_at DESC) WHERE cost_micros > 0;

-- The wrap's own due check.
CREATE INDEX insight_briefs_kind_day_idx ON insight_briefs (kind, day DESC);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP INDEX IF EXISTS insight_briefs_kind_day_idx;
DROP INDEX IF EXISTS insight_briefs_spend_idx;
ALTER TABLE insight_briefs DROP CONSTRAINT IF EXISTS insight_briefs_tenant_day_kind_key;
-- Only restorable while at most one row per (tenant, day) survives; a weekly row
-- sharing a Monday with a daily one will block this, which is correct — the Down
-- cannot silently discard a café's brief.
ALTER TABLE insight_briefs ADD CONSTRAINT insight_briefs_tenant_id_day_key UNIQUE (tenant_id, day);

ALTER TABLE insight_briefs
  DROP COLUMN IF EXISTS cost_micros,
  DROP COLUMN IF EXISTS output_tokens,
  DROP COLUMN IF EXISTS input_tokens,
  DROP COLUMN IF EXISTS raw_response,
  DROP COLUMN IF EXISTS prompt_sha256,
  DROP COLUMN IF EXISTS llm_model,
  DROP COLUMN IF EXISTS llm_status,
  DROP COLUMN IF EXISTS narrative,
  DROP COLUMN IF EXISTS headline,
  DROP COLUMN IF EXISTS kind;

-- +goose StatementEnd
