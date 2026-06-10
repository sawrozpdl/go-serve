-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- Remediate schema drift: drop the orphaned `sync_tenant_member_primary_role`
-- trigger + function.
--
-- These objects exist in some local/dev databases as leftovers from an early
-- iteration of the membership model. The trigger function references
-- NEW.role / NEW.roles on tenant_members and tenant_invites — columns that
-- migration 0019 removed when membership roles moved to tenant_member_roles.
-- As a result the trigger raises `record "new" has no field "role"` (SQLSTATE
-- 42703) on ANY insert/update of tenant_members or tenant_invites, breaking
-- the invite flow.
--
-- No migration ever created these objects, so this DROP is a no-op on a clean
-- database and a cleanup on a drifted one. Guarded with IF EXISTS so it is
-- safe everywhere.
-- =========================================================================

DROP TRIGGER IF EXISTS sync_tenant_invite_primary_role_trg ON tenant_invites;
DROP TRIGGER IF EXISTS sync_tenant_member_primary_role_trg ON tenant_members;
DROP FUNCTION IF EXISTS sync_tenant_member_primary_role();

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- No-op: these objects are drift that no migration created, so there is
-- nothing to restore on rollback.
SELECT 1;
-- +goose StatementEnd
