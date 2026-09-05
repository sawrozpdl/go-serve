-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0075 — Cafe balance is owner-only
--
-- The API has always treated finance as owner-only: GET /finance/cafe-balance
-- and /cafe-summary are gated on finance:read, which no system role except
-- owner ('*:*') holds. The web nav entry and the Accounts page were gated on
-- account:read instead — which manager DOES hold — so a manager could open
-- "Cafe balance" and read real drawer/online/bank figures from
-- /accounts/balances, beside a total that had quietly 403'd to zero.
--
-- Closing the UI alone would have left the endpoint open to anyone who knew
-- the URL, so the grant goes too: manager loses account:read, and the balance
-- surface is owner-only in the UI and the API at once.
--
-- manager KEEPS transfer:* deliberately. Recording a cash-to-bank deposit is
-- day-to-day floor work; knowing what the cafe is worth is not. The Accounts
-- page now renders only the half the member is entitled to.
--
-- Additive-only is not possible here (this is a revocation), so unlike 0066
-- this DOES discard a grant an operator may have re-added by hand to the
-- manager role. That is the intent: account:read on manager is exactly the
-- default being withdrawn. A tenant that wants its managers to see balances
-- can grant finance:read (or account:read) back in Settings -> Roles.
--
-- 'owner' is untouched — it holds '*:*' and is pinned there by a trigger.
-- =========================================================================

DELETE FROM role_permissions rp
USING roles r
WHERE rp.role_id = r.id
  AND r.key = 'manager'
  AND rp.permission = 'account:read';

-- The auth layer caches permission sets keyed by (tenant, user, roles_version).
-- Without this bump a signed-in manager keeps the revoked grant until their
-- cache entry happens to expire. See 0019_rbac.sql.
UPDATE tenants SET roles_version = roles_version + 1;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'account:read'
FROM roles r
WHERE r.key = 'manager'
ON CONFLICT DO NOTHING;

UPDATE tenants SET roles_version = roles_version + 1;
-- +goose StatementEnd
