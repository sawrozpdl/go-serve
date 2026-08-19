-- +goose Up
-- +goose StatementBegin
-- 0066: back-fill the engage:* permissions onto existing tenants' system roles.
-- The permissions.json manifest already carries these for newly-provisioned
-- tenants (rbac.SeedSystemRoles reads it); this covers every tenant created
-- before 0065. Additive only (ON CONFLICT DO NOTHING), so any custom grants on
-- these unlocked roles survive.
--
-- 'owner' is absent because it holds '*:*' and is pinned there by a trigger.
--
-- waiter and kitchen get read + redeem but NOT update: whoever is standing at
-- the till has to be able to honour a guest's code, and both roles already hold
-- adjustment:apply and order:settle — a reward redemption is the same act. They
-- do not get contacts_read/contacts_delete, which are bulk PII.
--
-- Kept in its own migration so rolling back a permissions change never has to
-- drop the 0065 tables.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('manager', 'engage:*'),
  ('waiter',  'engage:read'),
  ('waiter',  'engage:redeem'),
  ('kitchen', 'engage:read'),
  ('kitchen', 'engage:redeem')
) AS p(role_key, permission) ON r.key = p.role_key
ON CONFLICT DO NOTHING;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Best-effort reversal: drops exactly the (role, permission) pairs added above.
-- This may remove a grant an operator added by hand to one of these roles.
DELETE FROM role_permissions rp
USING roles r, (VALUES
  ('manager', 'engage:*'),
  ('waiter',  'engage:read'),
  ('waiter',  'engage:redeem'),
  ('kitchen', 'engage:read'),
  ('kitchen', 'engage:redeem')
) AS p(role_key, permission)
WHERE rp.role_id = r.id AND r.key = p.role_key AND rp.permission = p.permission;
-- +goose StatementEnd
