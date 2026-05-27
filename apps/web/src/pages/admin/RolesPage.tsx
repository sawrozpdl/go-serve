// /admin/roles — RBAC editor. Owner-only by default (gated on role:read).
//
// Layout: left-rail list of roles (system + custom), right pane is the
// editor. Owner is rendered locked; other system roles allow permission
// edits but not key/delete; custom roles allow full CRUD.

import { useEffect, useMemo, useState } from 'react';
import { Lock, Plus, Save, Shield, Trash2, Users } from 'lucide-react';

import { PageShell } from '@/components/PageShell';
import { useConfirm } from '@/components/ConfirmDialog';
import { toast } from '@/lib/toast';
import {
  usePermissionManifest,
  useRoles,
  useCreateRole,
  useUpdateRole,
  useDeleteRole,
  type PermissionDef,
  type ResourceDef,
  type Role,
} from '@/lib/api';

export function RolesPage() {
  const manifest = usePermissionManifest();
  const roles = useRoles();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Default selection: first role in the list.
  useEffect(() => {
    if (!selectedId && roles.data && roles.data.length > 0 && !creating) {
      const first = roles.data[0];
      if (first) setSelectedId(first.id);
    }
  }, [roles.data, selectedId, creating]);

  const selected = roles.data?.find((r) => r.id === selectedId) ?? null;
  const loading = manifest.isPending || roles.isPending;

  return (
    <PageShell
      eyebrow="access control"
      title="Roles"
      actions={
        <span className="meta-line">
          {roles.data?.length ?? 0} role{(roles.data?.length ?? 0) === 1 ? '' : 's'}
        </span>
      }
    >
      {loading && <div className="empty-state">Loading…</div>}
      {!loading && manifest.data && roles.data && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(220px, 280px) 1fr',
            gap: 20,
            alignItems: 'flex-start',
          }}
        >
          {/* Role list */}
          <div className="panel" style={{ padding: 8 }}>
            <button
              type="button"
              className="btn primary"
              style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
              onClick={() => {
                setCreating(true);
                setSelectedId(null);
              }}
            >
              <Plus size={14} strokeWidth={1.5} />
              New role
            </button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {roles.data.map((r) => {
                const active = !creating && r.id === selectedId;
                return (
                  <button
                    type="button"
                    key={r.id}
                    className={`role-list-row ${active ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedId(r.id);
                      setCreating(false);
                    }}
                  >
                    <div className="role-list-row-head">
                      <span className="role-list-row-name">
                        {r.locked && <Lock size={11} strokeWidth={1.6} />}
                        {!r.locked && <Shield size={11} strokeWidth={1.6} />}
                        {r.name}
                      </span>
                      {r.is_system && <span className="pill">system</span>}
                    </div>
                    <div className="role-list-row-meta">
                      <span>{r.permissions.length} perms</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Users size={10} strokeWidth={1.6} />
                        {r.member_count}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Editor */}
          {creating && (
            <RoleEditor
              manifestPermissions={manifest.data.permissions}
              manifestResources={manifest.data.resources}
              role={null}
              onCancel={() => setCreating(false)}
              onSaved={(r) => {
                setCreating(false);
                setSelectedId(r.id);
              }}
            />
          )}
          {!creating && selected && (
            <RoleEditor
              manifestPermissions={manifest.data.permissions}
              manifestResources={manifest.data.resources}
              role={selected}
              onCancel={() => setSelectedId(null)}
              onSaved={() => undefined}
            />
          )}
          {!creating && !selected && (
            <div className="panel">
              <div className="empty-state">Select a role to view or edit.</div>
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}

function RoleEditor({
  manifestPermissions,
  manifestResources,
  role,
  onCancel,
  onSaved,
}: {
  manifestPermissions: PermissionDef[];
  manifestResources: ResourceDef[];
  role: Role | null;
  onCancel: () => void;
  onSaved: (r: Role) => void;
}) {
  const create = useCreateRole();
  const update = useUpdateRole();
  const remove = useDeleteRole();
  const confirm = useConfirm();
  const isNew = !role;
  const locked = !!role?.locked;

  const [key, setKey] = useState(role?.key ?? '');
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [grants, setGrants] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setKey(role?.key ?? '');
    setName(role?.name ?? '');
    setDescription(role?.description ?? '');
    setGrants(new Set(role?.permissions ?? []));
    setErr(null);
  }, [role?.id]);

  const grouped = useMemo(() => {
    return manifestResources.map((res) => ({
      resource: res,
      permissions: manifestPermissions.filter((p) => p.resource === res.key),
    }));
  }, [manifestPermissions, manifestResources]);

  const hasGlobal = grants.has('*:*');

  const toggleGrant = (token: string) => {
    if (locked) return;
    setGrants((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  };

  const onSave = async () => {
    setErr(null);
    try {
      if (isNew) {
        const created = await create.mutateAsync({
          key: key.trim(),
          name: name.trim(),
          description: description.trim(),
          permissions: Array.from(grants),
        });
        toast.success('Role created', created.name);
        onSaved(created);
      } else if (role) {
        const updated = await update.mutateAsync({
          id: role.id,
          name: name.trim(),
          description: description.trim(),
          permissions: Array.from(grants),
        });
        toast.success('Role saved', updated.name);
        onSaved(updated);
      }
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Failed');
    }
  };

  const onDelete = async () => {
    if (!role || locked) return;
    const ok = await confirm({
      title: `Delete ${role.name}?`,
      message: (
        <>
          This removes the role from this workspace. Members holding this role
          must be reassigned first ({role.member_count}{' '}
          {role.member_count === 1 ? 'member' : 'members'} currently hold it).
        </>
      ),
      danger: true,
      confirmLabel: 'Delete role',
    });
    if (!ok) return;
    setErr(null);
    try {
      await remove.mutateAsync(role.id);
      toast.success('Role deleted', role.name);
      onCancel();
    } catch (e: unknown) {
      setErr((e as { message?: string }).message ?? 'Failed');
    }
  };

  return (
    <div className="panel">
      {locked && (
        <div className="banner-info" style={{ marginTop: 0, marginBottom: 12 }}>
          The Owner role is immutable — it always grants every permission and cannot be edited or removed.
        </div>
      )}
      {err && <div className="banner-error" style={{ marginBottom: 12 }}>{err}</div>}

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: '180px 1fr' }}>
        <div>
          <label className="form-label">Key</label>
          <input
            value={key}
            onChange={(e) => setKey(e.target.value.toLowerCase())}
            disabled={!isNew || locked}
            placeholder="cashier"
            pattern="[a-z][a-z0-9_-]{0,62}"
            style={{ width: '100%' }}
          />
          <div className="meta" style={{ marginTop: 4 }}>
            lowercase, used in code; immutable after create
          </div>
        </div>
        <div>
          <label className="form-label">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={locked}
            placeholder="Cashier"
            required
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label className="form-label">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={locked}
            placeholder="What this role can do, in plain language"
            style={{ width: '100%' }}
          />
        </div>
      </div>

      <h3 style={{ marginTop: 20, marginBottom: 8 }}>Permissions</h3>

      <label
        className="role-perm-row"
        style={{ marginBottom: 12, borderRadius: 2, padding: '8px 10px', background: 'rgba(255,163,25,0.06)' }}
      >
        <input
          type="checkbox"
          checked={hasGlobal}
          disabled={locked}
          onChange={() => toggleGrant('*:*')}
        />
        <div>
          <strong>Grant everything (*:*)</strong>
          <div className="meta">Wildcard — supersedes every individual permission below.</div>
        </div>
      </label>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 16,
        }}
      >
        {grouped.map(({ resource, permissions }) => {
          const wildcardToken = `${resource.key}:*`;
          const hasWildcard = grants.has(wildcardToken) || hasGlobal;
          return (
            <div key={resource.key} className="role-perm-group">
              <div className="role-perm-group-head">
                <span>{resource.label}</span>
                <label className="role-wildcard">
                  <input
                    type="checkbox"
                    checked={grants.has(wildcardToken)}
                    disabled={locked || hasGlobal}
                    onChange={() => toggleGrant(wildcardToken)}
                  />
                  <span>any</span>
                </label>
              </div>
              {permissions.map((p) => {
                const checked = grants.has(p.key) || hasWildcard;
                return (
                  <label key={p.key} className="role-perm-row">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={locked || hasWildcard}
                      onChange={() => toggleGrant(p.key)}
                    />
                    <div>
                      <strong>{p.label}</strong>
                      <div className="meta" style={{ fontSize: 11 }}>
                        <code>{p.key}</code> — {p.description}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
        <div>
          {!isNew && !locked && role && !role.is_system && (
            <button
              type="button"
              className="btn danger"
              onClick={onDelete}
              disabled={remove.isPending}
            >
              <Trash2 size={14} strokeWidth={1.5} />
              {remove.isPending ? 'Deleting…' : 'Delete role'}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          {!locked && (
            <button
              type="button"
              className="btn primary"
              onClick={onSave}
              disabled={create.isPending || update.isPending}
            >
              <Save size={14} strokeWidth={1.5} />
              {create.isPending || update.isPending
                ? 'Saving…'
                : isNew
                  ? 'Create role'
                  : 'Save changes'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
