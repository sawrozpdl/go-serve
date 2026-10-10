-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0087 — Partner capital, and one company balance.
--
-- The platform's books (0060) knew what cafés paid and what we spent, but not
-- where the starting money came from. The founders put money in ("1 lakh
-- each"), occasionally take some out, and sometimes just buy a printer with
-- their own card. All three belong to that person's capital.
--
-- Two additions, both deliberately small:
--
--   1. platform_capital_entries — money a person put into (or took out of)
--      the company's bank or wallet. Soft-deleted like platform_expenses, so a
--      typo is fixed by deleting it rather than with a reversing entry.
--
--   2. platform_expenses.paid_from gains 'out_of_pocket': somebody paid
--      personally. It counts as THEIR investment, nothing is owed back, and
--      company money doesn't move.
--
-- Out-of-pocket spending is NOT copied into the capital table. A person's
-- capital is derived on read from both tables, so the two can't disagree and
-- deleting the expense takes it out of their capital with no second write.
-- Same "derive, never store" rule as the cash holdings.
-- =========================================================================

CREATE TABLE platform_capital_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id    uuid NOT NULL REFERENCES platform_people(id) ON DELETE RESTRICT,
  kind         text NOT NULL CHECK (kind IN ('contribution', 'withdrawal')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency     text NOT NULL DEFAULT 'NPR',
  occurred_on  date NOT NULL,
  -- Which company account the money landed in / left from.
  account      text NOT NULL CHECK (account IN ('bank', 'wallet')),
  note         text NOT NULL DEFAULT '',
  recorded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX platform_capital_entries_person_idx
  ON platform_capital_entries (person_id, occurred_on DESC) WHERE deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON platform_capital_entries TO app;

ALTER TABLE platform_expenses
  DROP CONSTRAINT platform_expenses_paid_from_check,
  DROP CONSTRAINT platform_expenses_paid_from_valid;
ALTER TABLE platform_expenses
  ADD CONSTRAINT platform_expenses_paid_from_check
    CHECK (paid_from IN ('bank', 'wallet', 'person_cash', 'out_of_pocket')),
  -- Both person-funded kinds must name the person; the account kinds must not.
  ADD CONSTRAINT platform_expenses_paid_from_valid
    CHECK ((paid_from IN ('person_cash', 'out_of_pocket')) = (paid_by_person_id IS NOT NULL));

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

-- Fails if any out_of_pocket expenses exist — deliberately: silently
-- reclassifying them would invent money in the bank.
ALTER TABLE platform_expenses
  DROP CONSTRAINT platform_expenses_paid_from_check,
  DROP CONSTRAINT platform_expenses_paid_from_valid;
ALTER TABLE platform_expenses
  ADD CONSTRAINT platform_expenses_paid_from_check
    CHECK (paid_from IN ('bank', 'wallet', 'person_cash')),
  ADD CONSTRAINT platform_expenses_paid_from_valid
    CHECK ((paid_from = 'person_cash') = (paid_by_person_id IS NOT NULL));

DROP TABLE IF EXISTS platform_capital_entries;

-- +goose StatementEnd
