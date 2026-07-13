-- +goose Up
-- +goose StatementBegin

-- =========================================================================
-- 0052: let a full tenant delete cascade through the owner-role guard.
--
-- rbac_block_owner_role_mutation() (0019) unconditionally raised 23514 on any
-- DELETE of the system owner role — including the cascade fired by
-- `DELETE FROM tenants` (roles.tenant_id is ON DELETE CASCADE). That made a
-- complete tenant delete fail with "cannot delete the system owner role".
--
-- Fix: when the owning tenant is already gone in this transaction, the delete
-- IS a cascade from the tenant delete, so allow it. This mirrors the
-- "is the tenant still there?" guard rbac_assert_owner_present already uses.
-- Normal (tenant-present) deletes are still blocked, and the UPDATE guard is
-- unchanged.
-- =========================================================================

CREATE OR REPLACE FUNCTION rbac_block_owner_role_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (TG_OP = 'DELETE' AND OLD.is_system AND OLD.key = 'owner') THEN
    -- If the tenant itself is being deleted in this tx the row is (about to be)
    -- gone — this is a legitimate cascade, so let the owner role go with it.
    PERFORM 1 FROM tenants WHERE id = OLD.tenant_id;
    IF NOT FOUND THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'cannot delete the system owner role'
      USING ERRCODE = '23514';
  END IF;
  IF (TG_OP = 'UPDATE' AND OLD.is_system AND OLD.key = 'owner') THEN
    IF NEW.key <> OLD.key OR NEW.is_system <> OLD.is_system THEN
      RAISE EXCEPTION 'cannot rename the system owner role'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$fn$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION rbac_block_owner_role_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (TG_OP = 'DELETE' AND OLD.is_system AND OLD.key = 'owner') THEN
    RAISE EXCEPTION 'cannot delete the system owner role'
      USING ERRCODE = '23514';
  END IF;
  IF (TG_OP = 'UPDATE' AND OLD.is_system AND OLD.key = 'owner') THEN
    IF NEW.key <> OLD.key OR NEW.is_system <> OLD.is_system THEN
      RAISE EXCEPTION 'cannot rename the system owner role'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$fn$;
-- +goose StatementEnd
