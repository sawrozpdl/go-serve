-- +goose Up
-- ReclassifyPayment flips a payment's method in place (cash ↔ online) to
-- fix wrong-method entries while the shift is still open. 0004 only granted
-- SELECT, INSERT, DELETE. RLS (payments_isolation) still tenant-scopes the
-- update.
GRANT UPDATE ON payments TO app;

-- +goose Down
REVOKE UPDATE ON payments FROM app;
