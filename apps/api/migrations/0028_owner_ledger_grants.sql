-- +goose Up
-- Expense editing updates the paired loan_advance row in place, and
-- DeleteExpense already issues DELETE FROM owner_ledger — but 0014 only
-- granted SELECT, INSERT, so both fail under the runtime app role.
GRANT UPDATE, DELETE ON owner_ledger TO app;

-- +goose Down
REVOKE UPDATE, DELETE ON owner_ledger FROM app;
