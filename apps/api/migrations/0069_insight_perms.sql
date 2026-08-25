-- +goose Up
-- +goose StatementBegin
-- 0069: back-fill insight:* onto existing tenants' system roles.
--
-- The manifest already carries these for newly-provisioned tenants
-- (rbac.SeedSystemRoles reads permissions.json); this covers every tenant
-- created before 0068. Additive only, so custom grants on these roles survive.
--
-- 'owner' is absent because it holds '*:*' and a trigger pins it there.
--
-- waiter and kitchen get NOTHING, unlike the engage back-fill in 0066. A
-- redemption is something the person at the till has to be able to do; a
-- finding about the café's margins, credit book or drawer discipline is not.
-- And it would mostly be pointless anyway: each detector declares its own
-- permission (report:read, shift:read, house_tab:read, menu:read) and the brief
-- is filtered per recipient, so a waiter granted insight:read would see an
-- almost empty list.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'insight:*'
FROM roles r
WHERE r.key = 'manager'
ON CONFLICT DO NOTHING;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM role_permissions rp
USING roles r
WHERE rp.role_id = r.id AND r.key = 'manager' AND rp.permission = 'insight:*';
-- +goose StatementEnd
