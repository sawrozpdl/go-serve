import { useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { formatNPR } from '@/components/Money';
import { toast } from '@/lib/toast';
import { useConfirm } from '@/components/ConfirmDialog';
import {
  useCreateModifier,
  useCreateModifierGroup,
  useDeleteModifier,
  useDeleteModifierGroup,
  useModifierGroups,
  useUpdateModifier,
  useUpdateModifierGroup,
  type MenuModifier,
  type ModifierGroup,
} from '@/lib/api';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { EmptyState } from '@/components/EmptyState';

/**
 * Add-on catalog editor. Groups hold choices; a group is then attached to any
 * number of items and/or categories from the item/category forms.
 *
 * Money is entered in rupees and stored in paisa, matching every other price
 * field in the app.
 */

// Rupees ⇄ paisa, the same convention the item form uses.
const toPaisa = (rupees: string): number => Math.round(Number(rupees || '0') * 100);
const toRupees = (paisa: number): string => String(paisa / 100);

export function AddOnsManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal
      open={open}
      title="Add-ons"
      subtitle="Reusable extras you can attach to items or whole categories"
      onClose={onClose}
      size="wide"
    >
      <AddOnsManagerBody />
    </Modal>
  );
}

function AddOnsManagerBody() {
  const groups = useModifierGroups();
  const createGroup = useCreateModifierGroup();
  const [newName, setNewName] = useState('');

  if (groups.isLoading) return <LoadingState label="Loading add-ons" />;
  if (groups.isError) {
    return <ErrorState hint={groups.error.message} onRetry={() => void groups.refetch()} compact />;
  }

  const submitNew = () => {
    const name = newName.trim();
    if (!name) return;
    createGroup.mutate(
      { name },
      {
        onSuccess: () => {
          setNewName('');
          toast.success('Group added', name);
        },
        onError: (e) => toast.error('Could not add group', e.message),
      },
    );
  };

  return (
    <div className="addon-mgr">
      <div className="addon-mgr-new">
        <input
          className="input"
          placeholder="New group name — e.g. Sandwich extras"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitNew();
            }
          }}
          aria-label="New add-on group name"
        />
        <button
          type="button"
          className="btn primary"
          onClick={submitNew}
          disabled={!newName.trim() || createGroup.isPending}
        >
          <Plus size={14} strokeWidth={1.8} /> Add group
        </button>
      </div>

      {(groups.data ?? []).length === 0 ? (
        <EmptyState
          title="No add-ons yet"
          hint="Create a group like “Sandwich extras”, put “Extra cheese” in it, then attach the group to the items that offer it."
        />
      ) : (
        (groups.data ?? []).map((g) => <GroupCard key={g.id} group={g} />)
      )}
    </div>
  );
}

function GroupCard({ group }: { group: ModifierGroup }) {
  const updateGroup = useUpdateModifierGroup();
  const deleteGroup = useDeleteModifierGroup();
  const createMod = useCreateModifier();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [minSelect, setMinSelect] = useState(String(group.min_select));
  const [maxSelect, setMaxSelect] = useState(group.max_select == null ? '' : String(group.max_select));
  const [newMod, setNewMod] = useState({ name: '', price: '' });

  const attachedTo = group.item_count + group.category_count;

  const saveGroup = () => {
    updateGroup.mutate(
      {
        id: group.id,
        patch: {
          name: name.trim() || group.name,
          min_select: Number(minSelect || '0'),
          // Empty means unlimited — sent as an explicit null so the server can
          // tell "clear it" from "leave alone".
          max_select: maxSelect.trim() === '' ? null : Number(maxSelect),
        },
      },
      {
        onSuccess: () => setEditing(false),
        onError: (e) => toast.error('Could not save group', e.message),
      },
    );
  };

  const addMod = () => {
    const n = newMod.name.trim();
    if (!n) return;
    createMod.mutate(
      { groupId: group.id, body: { name: n, price_cents: toPaisa(newMod.price) } },
      {
        onSuccess: () => setNewMod({ name: '', price: '' }),
        onError: (e) => toast.error('Could not add', e.message),
      },
    );
  };

  const removeGroup = async () => {
    if (
      !(await confirm({
        title: `Delete “${group.name}”?`,
        message:
          attachedTo > 0
            ? `It's still attached to ${group.item_count} item(s) and ${group.category_count} category(ies). Detach it from those first.`
            : 'Its add-ons will be removed from the menu. Serves already sold keep their record.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    ) {
      return;
    }
    deleteGroup.mutate(group.id, {
      onError: (e) => toast.error('Could not delete', e.message),
    });
  };

  return (
    <div className="addon-mgr-group">
      <div className="addon-mgr-group-head">
        {editing ? (
          <div className="addon-mgr-edit">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Group name"
            />
            <label className="addon-mgr-num">
              min
              <input
                className="input"
                type="number"
                min={0}
                value={minSelect}
                onChange={(e) => setMinSelect(e.target.value)}
                aria-label="Minimum choices"
              />
            </label>
            <label className="addon-mgr-num">
              max
              <input
                className="input"
                type="number"
                min={1}
                placeholder="∞"
                value={maxSelect}
                onChange={(e) => setMaxSelect(e.target.value)}
                aria-label="Maximum choices (blank = unlimited)"
              />
            </label>
            <button type="button" className="btn primary icon" onClick={saveGroup} aria-label="Save group">
              <Check size={14} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="btn icon"
              onClick={() => setEditing(false)}
              aria-label="Cancel"
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>
        ) : (
          <>
            <div className="addon-mgr-title">
              <strong>{group.name}</strong>
              <span className="addon-mgr-meta">
                {group.min_select > 0 ? `required · min ${group.min_select}` : 'optional'}
                {group.max_select != null ? ` · max ${group.max_select}` : ''}
                {/* Reuse is the point of groups, so surface it: it tells the
                    operator that editing here changes several items at once. */}
                {attachedTo > 0
                  ? ` · on ${group.item_count} item(s), ${group.category_count} category(ies)`
                  : ' · not attached yet'}
              </span>
            </div>
            <div className="addon-mgr-actions">
              <button
                type="button"
                className="btn icon"
                onClick={() => setEditing(true)}
                aria-label={`Edit ${group.name}`}
              >
                <Pencil size={13} strokeWidth={1.7} />
              </button>
              <button
                type="button"
                className="btn icon danger"
                onClick={removeGroup}
                aria-label={`Delete ${group.name}`}
              >
                <Trash2 size={13} strokeWidth={1.7} />
              </button>
            </div>
          </>
        )}
      </div>

      <div className="addon-mgr-mods">
        {group.modifiers.length === 0 ? (
          <div className="drill-empty">Nothing in this group yet.</div>
        ) : (
          group.modifiers.map((m) => <ModifierRow key={m.id} groupId={group.id} mod={m} />)
        )}
      </div>

      <div className="addon-mgr-new addon-mgr-new--mod">
        <input
          className="input"
          placeholder="Add-on name — e.g. Extra cheese"
          value={newMod.name}
          onChange={(e) => setNewMod({ ...newMod, name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addMod();
            }
          }}
          aria-label={`New add-on name in ${group.name}`}
        />
        <input
          className="input addon-mgr-price"
          type="number"
          min={0}
          step="0.01"
          placeholder="0"
          value={newMod.price}
          onChange={(e) => setNewMod({ ...newMod, price: e.target.value })}
          aria-label={`New add-on price in ${group.name}`}
        />
        <button type="button" className="btn" onClick={addMod} disabled={!newMod.name.trim()}>
          <Plus size={13} strokeWidth={1.8} /> Add
        </button>
      </div>
    </div>
  );
}

function ModifierRow({ groupId, mod }: { groupId: string; mod: MenuModifier }) {
  const update = useUpdateModifier();
  const remove = useDeleteModifier();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(mod.name);
  const [price, setPrice] = useState(toRupees(mod.price_cents));
  const [cost, setCost] = useState(mod.cost_cents == null ? '' : toRupees(mod.cost_cents));

  const save = () => {
    update.mutate(
      {
        groupId,
        id: mod.id,
        patch: {
          name: name.trim() || mod.name,
          price_cents: toPaisa(price),
          // Blank means "cost unknown" — an explicit null, not zero, so COGS
          // treats it as unset rather than free to make.
          cost_cents: cost.trim() === '' ? null : toPaisa(cost),
        },
      },
      {
        onSuccess: () => setEditing(false),
        onError: (e) => toast.error('Could not save', e.message),
      },
    );
  };

  if (editing) {
    return (
      <div className="addon-mgr-mod addon-mgr-edit">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Add-on name" />
        <label className="addon-mgr-num">
          price
          <input
            className="input addon-mgr-price"
            type="number"
            min={0}
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            aria-label="Add-on price"
          />
        </label>
        <label className="addon-mgr-num">
          cost
          <input
            className="input addon-mgr-price"
            type="number"
            min={0}
            step="0.01"
            placeholder="unset"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            aria-label="Add-on cost"
          />
        </label>
        <button type="button" className="btn primary icon" onClick={save} aria-label="Save add-on">
          <Check size={13} strokeWidth={2} />
        </button>
        <button type="button" className="btn icon" onClick={() => setEditing(false)} aria-label="Cancel">
          <X size={13} strokeWidth={2} />
        </button>
      </div>
    );
  }

  return (
    <div className="addon-mgr-mod">
      <span className="addon-mgr-mod-name">{mod.name}</span>
      <span className="addon-mgr-mod-price">
        {mod.price_cents > 0 ? `+ ${formatNPR(mod.price_cents)}` : 'free'}
        {mod.cost_cents != null && (
          <span className="addon-mgr-mod-cost"> · costs {formatNPR(mod.cost_cents)}</span>
        )}
      </span>
      <button
        type="button"
        className="btn icon"
        onClick={() => setEditing(true)}
        aria-label={`Edit ${mod.name}`}
      >
        <Pencil size={12} strokeWidth={1.7} />
      </button>
      <button
        type="button"
        className="btn icon danger"
        aria-label={`Delete ${mod.name}`}
        onClick={async () => {
          if (
            !(await confirm({
              title: `Delete “${mod.name}”?`,
              message: 'Serves already sold keep their record of it.',
              danger: true,
            }))
          ) {
            return;
          }
          remove.mutate(
            { groupId, id: mod.id },
            { onError: (e) => toast.error('Could not delete', e.message) },
          );
        }}
      >
        <Trash2 size={12} strokeWidth={1.7} />
      </button>
    </div>
  );
}

/**
 * Multi-select of add-on groups, used by both the item form and the category
 * form. Whole-set semantics: the caller PUTs whatever is checked.
 */
export function ModifierGroupPicker({
  value,
  onChange,
  hint,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  hint?: string;
}) {
  const groups = useModifierGroups();
  const all = groups.data ?? [];
  if (all.length === 0) return null;

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <div className="field">
      <span className="label">Add-ons</span>
      {hint && <span className="hint">{hint}</span>}
      <div className="addon-picker">
        {all.map((g) => {
          const on = value.includes(g.id);
          return (
            <button
              key={g.id}
              type="button"
              className={`chip${on ? ' active' : ''}`}
              aria-pressed={on}
              onClick={() => toggle(g.id)}
            >
              {on && <Check size={12} strokeWidth={2.4} />} {g.name}
              <span className="addon-picker-count">{g.modifiers.length}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
