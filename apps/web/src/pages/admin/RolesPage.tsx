// /admin/roles — RBAC editor. Owner-only by default (gated on role:read).
//
// Layout: a fixed-height two-pane workspace. Left rail lists roles (system +
// custom) and scrolls on its own; the right pane is the editor with a sticky
// header (name + General/Permissions tabs), an internally-scrolling body, and
// a sticky action bar. Only the active region scrolls — the page frame stays
// put. Owner is rendered locked; other system roles allow permission edits but
// not key/delete; custom roles allow full CRUD.

import { useEffect, useMemo, useState } from 'react';
import {
  Lock,
  Plus,
  Save,
  Shield,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';

import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';
import { Tabs } from '@/components/Tabs';
import { useConfirm } from '@/components/ConfirmDialog';
import { toast } from '@/lib/toast';
import { usePermissions } from '@/lib/permissions';
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
  const { can } = usePermissions();
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
  const count = roles.data?.length ?? 0;

  return (
    <PageShell
      className="roles-shell"
      eyebrow="access control"
      title="Roles"
      subtitle="Define what each role can do, then assign them on the Team page."
      actions={
        <span className="meta-line">
          {count} role{count === 1 ? '' : 's'}
        </span>
      }
    >
      {loading && <LoadingState />}
      {((manifest.isError && !manifest.data) || (roles.isError && !roles.data)) && (
        <ErrorState
          onRetry={() => {
            if (manifest.isError) manifest.refetch();
            if (roles.isError) roles.refetch();
          }}
        />
      )}
      {!loading && manifest.data && roles.data && (
        <div className="roles-layout">
          {/* Role list */}
          <aside className="roles-rail panel">
            {can('role:create') && (
              <button
                type="button"
                className="btn primary roles-rail-new"
                onClick={() => {
                  setCreating(true);
                  setSelectedId(null);
                }}
              >
                <Plus size={14} strokeWidth={1.8} />
                New role
              </button>
            )}
            <div className="roles-rail-scroll">
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
                        {r.locked ? (
                          <Lock size={12} strokeWidth={1.8} />
                        ) : (
                          <Shield size={12} strokeWidth={1.8} />
                        )}
                        {r.name}
                      </span>
                      {r.is_system && <span className="pill">system</span>}
                    </div>
                    <div className="role-list-row-meta">
                      <span>
                        {r.locked ? 'all' : r.permissions.length} perm
                        {!r.locked && r.permissions.length === 1 ? '' : 's'}
                      </span>
                      <span className="role-list-row-members">
                        <Users size={11} strokeWidth={1.8} />
                        {r.member_count}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Editor */}
          {creating && (
            <RoleEditor
              key="new"
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
              key={selected.id}
              manifestPermissions={manifest.data.permissions}
              manifestResources={manifest.data.resources}
              role={selected}
              onCancel={() => setSelectedId(null)}
              onSaved={() => undefined}
            />
          )}
          {!creating && !selected && (
            <div className="role-editor role-editor--empty panel">
              <div className="empty-state">
                <Shield size={20} strokeWidth={1.4} style={{ opacity: 0.5 }} />
                <div>Select a role to view or edit</div>
              </div>
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}

type EditorTab = 'general' | 'permissions';

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
  const { can } = usePermissions();
  const create = useCreateRole();
  const update = useUpdateRole();
  const remove = useDeleteRole();
  const confirm = useConfirm();
  const isNew = !role;
  const locked = !!role?.locked;
  // The single footer Save button serves create (new role) or update
  // (existing role); gate it on whichever mutation it would fire.
  const canSave = isNew ? can('role:create') : can('role:update');

  const [tab, setTab] = useState<EditorTab>('general');
  const [key, setKey] = useState(role?.key ?? '');
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [grants, setGrants] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setTab('general');
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

  // Count of explicitly-granted permissions for the tab badge. The wildcard
  // tokens count as one each; '*:*' short-circuits to "all".
  const grantCount = grants.size;

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

  const saving = create.isPending || update.isPending;
  const headTitle = isNew ? 'New role' : role?.name;

  return (
    <section className="role-editor panel">
      {/* Sticky header: identity + tabs */}
      <header className="role-editor-head">
        <div className="role-editor-head-id">
          <span className={`role-editor-icon ${locked ? 'locked' : ''}`}>
            {locked ? (
              <Lock size={16} strokeWidth={1.8} />
            ) : isNew ? (
              <Sparkles size={16} strokeWidth={1.8} />
            ) : (
              <ShieldCheck size={16} strokeWidth={1.8} />
            )}
          </span>
          <div className="role-editor-head-text">
            <h2>{headTitle || 'Untitled role'}</h2>
            <div className="role-editor-head-meta">
              {role?.is_system && <span className="pill">system</span>}
              {locked && <span className="pill warn">locked</span>}
              {!isNew && role && (
                <span className="role-editor-head-members">
                  <Users size={12} strokeWidth={1.7} />
                  {role.member_count} member{role.member_count === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>
        </div>
        <Tabs
          items={[
            { key: 'general', label: 'General' },
            {
              key: 'permissions',
              label: 'Permissions',
              badge: (
                <span className="tab-count">{hasGlobal ? 'all' : grantCount}</span>
              ),
            },
          ]}
          active={tab}
          onChange={(k) => setTab(k as EditorTab)}
          ariaLabel="Role editor sections"
        />
      </header>

      {/* Scrollable body */}
      <div className="role-editor-body">
        {locked && (
          <div className="banner-info" style={{ marginTop: 0 }}>
            The Owner role is immutable — it always grants every permission and
            cannot be edited or removed.
          </div>
        )}
        {err && <div className="banner-error">{err}</div>}

        {tab === 'general' && (
          <div className="role-form">
            <div className="field">
              <label htmlFor="role-key">Key</label>
              <input
                id="role-key"
                value={key}
                onChange={(e) => setKey(e.target.value.toLowerCase())}
                disabled={!isNew || locked}
                placeholder="cashier"
                pattern="[a-z][a-z0-9_-]{0,62}"
              />
              <div className="field-hint">
                Lowercase identifier used in code — immutable after create.
              </div>
            </div>
            <div className="field">
              <label htmlFor="role-name">Name</label>
              <input
                id="role-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={locked}
                placeholder="Cashier"
                required
              />
              <div className="field-hint">
                Shown wherever the role appears in the app.
              </div>
            </div>
            <div className="field">
              <label htmlFor="role-desc">Description</label>
              <input
                id="role-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={locked}
                placeholder="What this role can do, in plain language"
              />
              <div className="field-hint">
                Optional — a one-line summary teammates will see.
              </div>
            </div>
          </div>
        )}

        {tab === 'permissions' && (
          <div className="role-perms">
            <label className="role-perm-all">
              <input
                type="checkbox"
                checked={hasGlobal}
                disabled={locked}
                onChange={() => toggleGrant('*:*')}
              />
              <div>
                <strong>Grant everything (*:*)</strong>
                <div className="meta">
                  Wildcard — supersedes every individual permission below.
                </div>
              </div>
            </label>

            <div className="role-perm-grid">
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
          </div>
        )}
      </div>

      {/* Sticky action bar */}
      <footer className="role-editor-foot">
        <div>
          {!isNew && !locked && role && !role.is_system && can('role:delete') && (
            <button
              type="button"
              className="btn danger"
              onClick={onDelete}
              disabled={remove.isPending}
            >
              <Trash2 size={14} strokeWidth={1.6} />
              {remove.isPending ? 'Deleting…' : 'Delete role'}
            </button>
          )}
        </div>
        <div className="role-editor-foot-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          {!locked && canSave && (
            <button
              type="button"
              className="btn primary"
              onClick={onSave}
              disabled={saving}
            >
              <Save size={14} strokeWidth={1.6} />
              {saving ? 'Saving…' : isNew ? 'Create role' : 'Save changes'}
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
