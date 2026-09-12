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
 *
 * LAYOUT NOTE, because it bit us: every row here is a labelled field grid
 * (`.addon-form`), not a bare flex row of inputs. Two reasons. `.modal
 * input:not(…)` carries a 22px stacking margin at specificity (0,6,1) that no
 * `.addon-*` class can outrank, so an unlabelled input in a centred flex row
 * floats above the button beside it; and `.modal label { display: block }`
 * likewise beats any inline-flex label, so "min ▭" pairs came out stacked and
 * unreadable. The grid embraces both instead of fighting them — the label sits
 * above its field the way it does everywhere else in the app, and the input's
 * margin is zeroed once, in one place.
 */

// Rupees ⇄ paisa, the same convention the item form uses.
const toPaisa = (rupees: string): number => Math.round(Number(rupees || '0') * 100);
const toRupees = (paisa: number): string => String(paisa / 100);

/** The one sentence that answers "what does an empty price mean?". */
const FREE_HINT = 'Leave the price at 0 and the choice is free — use it for “No ice” or “Extra spicy”.';

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
      <div className="addon-form addon-form--group">
        <label className="addon-field">
          <span>New group</span>
          <input
            className="input"
            placeholder="e.g. Sandwich extras"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitNew();
              }
            }}
          />
        </label>
        <button
          type="button"
          className="btn primary addon-form__action"
          onClick={submitNew}
          disabled={!newName.trim() || createGroup.isPending}
        >
          <Plus size={14} strokeWidth={1.8} /> Add group
        </button>
      </div>
      <div className="addon-mgr-note field-hint">
        A group is a question the waiter is asked — “Sandwich extras”, “Milk”, “Spice level”. Put the
        choices inside it, then attach the group to the items that offer it.
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
  const [newMod, setNewMod] = useState({ name: '', price: '', cost: '' });

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
      {
        groupId: group.id,
        body: {
          name: n,
          price_cents: toPaisa(newMod.price),
          // Blank means "cost unknown" — an explicit null, not zero, so COGS
          // treats it as unset rather than free to make. Offered here and not
          // only in the edit row, so a new add-on doesn't need a second pass
          // before profitability is right.
          cost_cents: newMod.cost.trim() === '' ? null : toPaisa(newMod.cost),
        },
      },
      {
        onSuccess: () => setNewMod({ name: '', price: '', cost: '' }),
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
          <div className="addon-form addon-form--edit-group">
            <label className="addon-field">
              <span>Group name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="addon-field addon-field--num">
              <span>Min</span>
              <input
                className="input"
                type="number"
                min={0}
                value={minSelect}
                onChange={(e) => setMinSelect(e.target.value)}
                aria-describedby={`addon-rule-${group.id}`}
              />
            </label>
            <label className="addon-field addon-field--num">
              <span>Max</span>
              <input
                className="input"
                type="number"
                min={1}
                placeholder="∞"
                value={maxSelect}
                onChange={(e) => setMaxSelect(e.target.value)}
                aria-describedby={`addon-rule-${group.id}`}
              />
            </label>
            <div className="addon-form__action addon-mgr-actions">
              <button type="button" className="btn primary icon" onClick={saveGroup} aria-label="Save group">
                <Check size={14} strokeWidth={2} />
              </button>
              <button type="button" className="btn icon" onClick={() => setEditing(false)} aria-label="Cancel">
                <X size={14} strokeWidth={2} />
              </button>
            </div>
            <div className="addon-form__note field-hint" id={`addon-rule-${group.id}`}>
              Min 0 makes the group optional; min 1 means the waiter must answer it. Leave max blank
              for any number.
            </div>
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

      <div className="addon-form addon-form--mod">
        <label className="addon-field">
          <span>Add-on</span>
          <input
            className="input"
            placeholder="e.g. Extra cheese"
            value={newMod.name}
            onChange={(e) => setNewMod({ ...newMod, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addMod();
              }
            }}
          />
        </label>
        <MoneyField
          label="Price"
          value={newMod.price}
          placeholder="0"
          onChange={(price) => setNewMod({ ...newMod, price })}
        />
        <MoneyField
          label="Cost"
          value={newMod.cost}
          placeholder="unset"
          onChange={(cost) => setNewMod({ ...newMod, cost })}
        />
        <button
          type="button"
          className="btn addon-form__action"
          onClick={addMod}
          disabled={!newMod.name.trim() || createMod.isPending}
        >
          <Plus size={13} strokeWidth={1.8} /> Add
        </button>
        <div className="addon-form__note field-hint">
          {FREE_HINT} Cost is what it costs you to make — leave it blank if you don’t track that yet.
        </div>
      </div>
    </div>
  );
}

/** Rupee-prefixed number field. The affix is what makes a bare "50" legible as
 *  money rather than a count of anything. */
function MoneyField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="addon-field addon-field--money">
      <span>{label}</span>
      <span className="addon-money">
        <span className="addon-money__affix" aria-hidden="true">
          Rs
        </span>
        <input
          className="input"
          type="number"
          min={0}
          step="0.01"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
    </label>
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
      <div className="addon-form addon-form--mod">
        <label className="addon-field">
          <span>Add-on</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <MoneyField label="Price" value={price} placeholder="0" onChange={setPrice} />
        <MoneyField label="Cost" value={cost} placeholder="unset" onChange={setCost} />
        <div className="addon-form__action addon-mgr-actions">
          <button type="button" className="btn primary icon" onClick={save} aria-label="Save add-on">
            <Check size={13} strokeWidth={2} />
          </button>
          <button type="button" className="btn icon" onClick={() => setEditing(false)} aria-label="Cancel">
            <X size={13} strokeWidth={2} />
          </button>
        </div>
        <div className="addon-form__note field-hint">{FREE_HINT}</div>
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
 *
 * It also carries the shortcut for the common case. Most of the time an
 * operator is not designing a question with rules — they just want "cheese
 * slice, Rs 30" available on the burger and the sandwich. `+ New add-on` does
 * exactly that: it creates the choice, files it in a group (an existing one if
 * this form already has just one, otherwise a plain optional group named after
 * whatever is being edited) and ticks it. Groups stay available for the cases
 * that need them — "pick one milk", required.
 */
export function ModifierGroupPicker({
  value,
  onChange,
  hint,
  /** Names the auto-created group, e.g. "Burger extras". */
  ownerName,
  /** Opens the catalog editor — the way out when the shortcut isn't enough. */
  onManage,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  hint?: string;
  ownerName?: string;
  onManage?: () => void;
}) {
  const groups = useModifierGroups();
  const createGroup = useCreateModifierGroup();
  const createMod = useCreateModifier();
  const all = groups.data ?? [];
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', price: '' });
  const busy = createGroup.isPending || createMod.isPending;

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  const submit = async () => {
    const name = draft.name.trim();
    if (!name || busy) return;
    try {
      // Reuse the group this form already points at when there's exactly one —
      // otherwise every new extra would spawn another group and the picker
      // would fill up with near-duplicates.
      const existing = value.length === 1 ? all.find((g) => g.id === value[0]) : undefined;
      const groupId =
        existing?.id ??
        (
          await createGroup.mutateAsync({
            name: ownerName ? `${ownerName} extras` : 'Extras',
            // Optional and unlimited: a plain extra, never a question the
            // waiter is forced to answer.
            min_select: 0,
            max_select: null,
          })
        ).id;
      await createMod.mutateAsync({
        groupId,
        body: { name, price_cents: toPaisa(draft.price) },
      });
      // Tick it here rather than waiting for a save: the form PUTs its whole
      // group list after the item saves, so a new group only sticks if it is in
      // that list — and this works the same for an item that doesn't exist yet.
      if (!value.includes(groupId)) onChange([...value, groupId]);
      setDraft({ name: '', price: '' });
      setAdding(false);
      toast.success('Add-on created', existing ? `Added to ${existing.name}` : name);
    } catch (e) {
      toast.error('Could not create add-on', (e as Error).message);
    }
  };

  return (
    <>
      {hint && <div className="field-hint">{hint}</div>}
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
        {!adding && (
          <button type="button" className="chip addon-picker-new" onClick={() => setAdding(true)}>
            <Plus size={12} strokeWidth={2.4} /> New add-on
          </button>
        )}
      </div>

      {adding && (
        <div className="addon-form addon-form--inline">
          <label className="addon-field">
            <span>Add-on</span>
            <input
              className="input"
              autoFocus
              placeholder="e.g. Cheese slice"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </label>
          <MoneyField
            label="Price"
            value={draft.price}
            placeholder="0"
            onChange={(price) => setDraft({ ...draft, price })}
          />
          <div className="addon-form__action addon-mgr-actions">
            <button
              type="button"
              className="btn primary"
              onClick={() => void submit()}
              disabled={!draft.name.trim() || busy}
            >
              Create
            </button>
            <button type="button" className="btn icon" onClick={() => setAdding(false)} aria-label="Cancel">
              <X size={13} strokeWidth={2} />
            </button>
          </div>
          <div className="addon-form__note field-hint">{FREE_HINT}</div>
        </div>
      )}

      {all.length === 0 && !adding && (
        // Never render nothing here. Returning null left the form's "Add-ons"
        // label sitting over empty space, which reads as a broken or missing
        // feature rather than an empty one.
        <div className="field-hint">
          Nothing to attach yet. Add one above, or{' '}
          {onManage ? (
            <button type="button" className="linklike" onClick={onManage}>
              open the add-ons editor
            </button>
          ) : (
            'open Menu → Add-ons'
          )}{' '}
          to build a group with rules (“pick one milk”).
        </div>
      )}
    </>
  );
}
