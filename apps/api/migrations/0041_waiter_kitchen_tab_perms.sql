-- +goose Up
-- +goose StatementBegin
-- 0041: by default, waiter + kitchen can settle tabs, edit/add/remove tab line
-- items, and apply discounts. The permissions.json manifest already carries
-- these for newly-provisioned tenants; this back-fills the roles of tenants
-- that were created before the change. Additive only (ON CONFLICT DO NOTHING) so
-- any custom grants on these (unlocked) roles are preserved.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('waiter',  'order:update_item'),
  ('waiter',  'order:void_item'),
  ('waiter',  'order:settle'),
  ('waiter',  'adjustment:read'),
  ('waiter',  'adjustment:apply'),
  ('waiter',  'adjustment:delete'),
  ('kitchen', 'order:read'),
  ('kitchen', 'order:add_items'),
  ('kitchen', 'order:update_item'),
  ('kitchen', 'order:void_item'),
  ('kitchen', 'order:settle'),
  ('kitchen', 'adjustment:read'),
  ('kitchen', 'adjustment:apply'),
  ('kitchen', 'adjustment:delete')
) AS p(role_key, permission) ON r.key = p.role_key
ON CONFLICT DO NOTHING;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Best-effort reversal: drop exactly the (role, permission) pairs added above.
-- This may remove a grant an operator added by hand to a waiter/kitchen role.
DELETE FROM role_permissions rp
USING roles r, (VALUES
  ('waiter',  'order:update_item'),
  ('waiter',  'order:void_item'),
  ('waiter',  'order:settle'),
  ('waiter',  'adjustment:read'),
  ('waiter',  'adjustment:apply'),
  ('waiter',  'adjustment:delete'),
  ('kitchen', 'order:read'),
  ('kitchen', 'order:add_items'),
  ('kitchen', 'order:update_item'),
  ('kitchen', 'order:void_item'),
  ('kitchen', 'order:settle'),
  ('kitchen', 'adjustment:read'),
  ('kitchen', 'adjustment:apply'),
  ('kitchen', 'adjustment:delete')
) AS p(role_key, permission)
WHERE rp.role_id = r.id AND r.key = p.role_key AND rp.permission = p.permission;
-- +goose StatementEnd
