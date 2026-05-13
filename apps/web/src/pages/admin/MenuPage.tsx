import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { ColorField } from '@/components/ColorField';
import { useConfirm } from '@/components/ConfirmDialog';
import { formatNPR, parsePriceInput } from '@/components/Money';
import {
  useMenuCategories,
  useCreateMenuCategory,
  useUpdateMenuCategory,
  useDeleteMenuCategory,
  useMenuItems,
  useCreateMenuItem,
  useUpdateMenuItem,
  useDeleteMenuItem,
  useInventoryItems,
  useMenuItemLink,
  usePutMenuItemLink,
  type MenuCategory,
  type MenuItem,
} from '@/lib/api';

export function MenuPage() {
  const cats = useMenuCategories();
  const [selectedCatId, setSelectedCatId] = useState<string | null>(null);

  // Auto-pick the first category once the list arrives, and recover when
  // the currently-selected category is deleted from another tab.
  useEffect(() => {
    const list = cats.data;
    if (!list || list.length === 0) return;
    const first = list[0];
    if (!first) return;
    if (!selectedCatId || !list.some((c) => c.id === selectedCatId)) {
      setSelectedCatId(first.id);
    }
  }, [cats.data, selectedCatId]);

  return (
    <>
      <div className="topbar">
        <div>
          <span className="eyebrow">catalog</span>
          <h1>Menu</h1>
        </div>
      </div>

      <div className="menu-split">
        <CategoriesPanel
          selectedId={selectedCatId}
          onSelect={setSelectedCatId}
        />
        <ItemsPanel selectedCatId={selectedCatId} />
      </div>
    </>
  );
}

// -------------------------------------------------------------------------
// Categories
// -------------------------------------------------------------------------

function CategoriesPanel({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const list = useMenuCategories();
  const create = useCreateMenuCategory();
  const update = useUpdateMenuCategory();
  const del = useDeleteMenuCategory();
  const confirm = useConfirm();

  const [editing, setEditing] = useState<Partial<MenuCategory> | null>(null);

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Categories</h3>
        <button
          type="button"
          className="btn primary"
          onClick={() => setEditing({ name: '', sort: (list.data?.length ?? 0) + 1, color: '' })}
        >
          <Plus size={14} strokeWidth={1.5} /> New
        </button>
      </div>

      {list.isPending && <div className="empty-state">loading…</div>}
      {list.data?.length === 0 && (
        <div className="empty-state">
          no categories yet.
          <br />
          add one to start building the menu.
        </div>
      )}

      {list.data && list.data.length > 0 && (
        <div className="cat-list">
          {list.data.map((c) => (
            <div
              key={c.id}
              className={`cat-row ${selectedId === c.id ? 'sel' : ''}`}
              onClick={() => onSelect(c.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(c.id);
                }
              }}
            >
              <span
                className="cat-dot"
                style={{ background: c.color || 'var(--ink-500)' }}
                aria-hidden
              />
              <span className="cat-name">{c.name}</span>
              {!c.is_active && <span className="pill">off</span>}
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="btn icon"
                  onClick={() => setEditing(c)}
                  aria-label="edit"
                >
                  <Pencil size={14} strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  className="btn icon danger"
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'Delete category?',
                      message: (
                        <>
                          Delete the <strong>{c.name}</strong> menu category?
                          Items in it will be hidden from the menu.
                        </>
                      ),
                      danger: true,
                    });
                    if (ok) del.mutate(c.id);
                  }}
                  aria-label="delete"
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <CategoryModal
        editing={editing}
        onClose={() => setEditing(null)}
        onSubmit={async (values) => {
          if (editing?.id) {
            await update.mutateAsync({ id: editing.id, patch: values });
          } else {
            await create.mutateAsync(values);
          }
          setEditing(null);
        }}
        pending={create.isPending || update.isPending}
      />
    </div>
  );
}

function CategoryModal({
  editing,
  onClose,
  onSubmit,
  pending,
}: {
  editing: Partial<MenuCategory> | null;
  onClose: () => void;
  onSubmit: (v: Partial<MenuCategory>) => Promise<void>;
  pending: boolean;
}) {
  const open = editing !== null;
  const [name, setName] = useState('');
  const [sort, setSort] = useState(0);
  const [color, setColor] = useState('');
  const [active, setActive] = useState(true);

  // Sync form state with the editing target whenever the modal (re)opens.
  // Using a key on the modal would be cleaner, but this small effect keeps
  // the form responsive without re-mounting.
  useSyncFormState(editing, (e) => {
    setName(e?.name ?? '');
    setSort(e?.sort ?? 0);
    setColor(e?.color ?? '');
    setActive(e?.is_active ?? true);
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing?.id ? 'edit category' : 'new category'}
      subtitle="cost-center bucket for revenue + cogs roll-up"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit({
            name,
            sort,
            color: color || null,
            is_active: active,
          });
        }}
      >
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />

        <label>Sort</label>
        <input
          type="number"
          value={sort}
          onChange={(e) => setSort(Number(e.target.value) || 0)}
        />

        <label>Color</label>
        <ColorField value={color} onChange={setColor} allowEmpty />

        {editing?.id && (
          <>
            <label>Status</label>
            <select value={active ? 'on' : 'off'} onChange={(e) => setActive(e.target.value === 'on')}>
              <option value="on">Active</option>
              <option value="off">Inactive</option>
            </select>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={pending}>
            {pending ? 'Saving…' : editing?.id ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------------------
// Items
// -------------------------------------------------------------------------

function ItemsPanel({ selectedCatId }: { selectedCatId: string | null }) {
  const cats = useMenuCategories();
  // Scope the items list by category so we don't re-render the whole catalog
  // when the user toggles between two categories with different stale times.
  const items = useMenuItems(selectedCatId ?? undefined);
  const create = useCreateMenuItem();
  const update = useUpdateMenuItem();
  const del = useDeleteMenuItem();
  const confirm = useConfirm();

  const [editing, setEditing] = useState<Partial<MenuItem> | null>(null);

  const selectedCat = cats.data?.find((c) => c.id === selectedCatId);

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{selectedCat ? `items · ${selectedCat.name}` : 'items'}</h3>
        <button
          type="button"
          className="btn primary"
          disabled={!selectedCatId}
          title={!selectedCatId ? 'Pick a category first' : undefined}
          onClick={() =>
            setEditing({ category_id: selectedCatId ?? '', name: '', price_cents: 0 })
          }
        >
          <Plus size={14} strokeWidth={1.5} /> New item
        </button>
      </div>

      {!selectedCatId && (
        <div className="empty-state">
          pick a category on the left to view its items.
        </div>
      )}

      {selectedCatId && items.isPending && <div className="empty-state">loading…</div>}
      {selectedCatId && items.data?.length === 0 && (
        <div className="empty-state">
          no items in this category yet.
          <br />
          click <strong>New item</strong> to add one.
        </div>
      )}

      {selectedCatId && items.data && items.data.length > 0 && (
        <table className="t">
          <thead>
            <tr>
              <th>Name</th>
              <th>SKU</th>
              <th style={{ textAlign: 'right' }}>Price</th>
              <th style={{ width: 80 }}>Status</th>
              <th style={{ width: 100 }}></th>
            </tr>
          </thead>
          <tbody>
            {items.data.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.name}</strong>
                  {m.description && (
                    <div style={{ fontSize: 11, color: 'var(--ink-400)', marginTop: 2 }}>{m.description}</div>
                  )}
                </td>
                <td className="sku">{m.sku ?? '—'}</td>
                <td className="num" style={{ textAlign: 'right' }}>
                  {formatNPR(m.price_cents)}
                </td>
                <td>
                  <span className={`pill ${m.is_active ? 'ok' : ''}`}>{m.is_active ? 'active' : 'off'}</span>
                </td>
                <td>
                  <div className="row-actions">
                    <button type="button" className="btn icon" onClick={() => setEditing(m)} aria-label="edit">
                      <Pencil size={14} strokeWidth={1.5} />
                    </button>
                    <button
                      type="button"
                      className="btn icon danger"
                      onClick={async () => {
                        const ok = await confirm({
                          title: 'Delete menu item?',
                          message: (
                            <>
                              Remove <strong>{m.name}</strong>{' '}
                              ({formatNPR(m.price_cents)}) from the menu?
                              Past sales remain in reports.
                            </>
                          ),
                          danger: true,
                        });
                        if (ok) del.mutate(m.id);
                      }}
                      aria-label="delete"
                    >
                      <Trash2 size={14} strokeWidth={1.5} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ItemModal
        editing={editing}
        categories={cats.data ?? []}
        onClose={() => setEditing(null)}
        onSubmit={async (values) => {
          if (editing?.id) {
            await update.mutateAsync({ id: editing.id, patch: values });
          } else {
            await create.mutateAsync(values);
          }
          setEditing(null);
        }}
        pending={create.isPending || update.isPending}
      />
    </div>
  );
}

function ItemModal({
  editing,
  categories,
  onClose,
  onSubmit,
  pending,
}: {
  editing: Partial<MenuItem> | null;
  categories: MenuCategory[];
  onClose: () => void;
  onSubmit: (v: Partial<MenuItem>) => Promise<void>;
  pending: boolean;
}) {
  const open = editing !== null;
  const inventoryItems = useInventoryItems();
  const existingLink = useMenuItemLink(editing?.id ?? undefined);
  const putLink = usePutMenuItemLink();

  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [priceText, setPriceText] = useState('');
  const [costText, setCostText] = useState('');
  const [sku, setSku] = useState('');
  const [active, setActive] = useState(true);
  const [linkInvId, setLinkInvId] = useState<string>('');
  const [linkQty, setLinkQty] = useState<string>('1');
  const [presetNotes, setPresetNotes] = useState<string[]>([]);
  const [noteDraft, setNoteDraft] = useState('');

  useSyncFormState(editing, (e) => {
    setName(e?.name ?? '');
    setCategoryId(e?.category_id ?? categories[0]?.id ?? '');
    setDescription(e?.description ?? '');
    setPriceText(e?.price_cents != null ? (e.price_cents / 100).toString() : '');
    setCostText(e?.cost_cents != null ? (e.cost_cents / 100).toString() : '');
    setSku(e?.sku ?? '');
    setActive(e?.is_active ?? true);
    setPresetNotes(e?.preset_notes ?? []);
    setNoteDraft('');
  });

  // When the link query resolves for an existing item, sync the form.
  useEffect(() => {
    if (existingLink.data) {
      setLinkInvId(existingLink.data.inventory_item_id);
      setLinkQty(existingLink.data.qty_consumed_per_sale);
    } else if (existingLink.data === null) {
      setLinkInvId('');
      setLinkQty('1');
    }
  }, [existingLink.data]);

  return (
    <Modal open={open} onClose={onClose} title={editing?.id ? 'edit item' : 'new item'} subtitle="catalog">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const cents = parsePriceInput(priceText);
          if (cents == null) return;
          // Cost is optional. Empty input = "leave it unset" on create, or
          // "leave existing value" on edit (the API uses COALESCE on null).
          const costRaw = costText.trim();
          const costCents = costRaw === '' ? undefined : parsePriceInput(costRaw);
          if (costRaw !== '' && costCents == null) return;
          // Save the menu item first; if it's a create, we get the new id.
          // The current onSubmit closes the modal, so we need to invert this:
          // onSubmit returns void, but we still want to PUT the link after.
          await onSubmit({
            name,
            category_id: categoryId,
            description,
            price_cents: cents,
            cost_cents: costCents ?? null,
            sku: sku || null,
            is_active: active,
            preset_notes: presetNotes,
          });
          // Sync the inventory link only when editing an existing item
          // (newly-created ids aren't in our scope here).
          if (editing?.id) {
            await putLink.mutateAsync({
              menuItemId: editing.id,
              inventory_item_id: linkInvId || null,
              qty_consumed_per_sale: linkQty,
            });
          }
        }}
      >
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />

        <label>Category</label>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <div className="row-inputs">
          <div>
            <label>Price (NPR)</label>
            <input
              inputMode="decimal"
              placeholder="180"
              value={priceText}
              onChange={(e) => setPriceText(e.target.value)}
              required
            />
          </div>
          <div>
            <label>Cost per unit (NPR)</label>
            <input
              inputMode="decimal"
              placeholder="optional, e.g. 30"
              value={costText}
              onChange={(e) => setCostText(e.target.value)}
            />
            <div className="field-hint">
              your cost to make/buy one. used in profitability — leave blank if you
              prefer to track cost via inventory + expenses only.
              {priceText && costText && parsePriceInput(priceText) && parsePriceInput(costText) ? (
                <>
                  {' '}
                  <strong style={{ color: 'var(--lime-fg)' }}>
                    margin {(((parsePriceInput(priceText)! - parsePriceInput(costText)!) / parsePriceInput(priceText)!) * 100).toFixed(0)}%
                  </strong>{' '}
                  ({formatNPR((parsePriceInput(priceText)! - parsePriceInput(costText)!))} per sale)
                </>
              ) : null}
            </div>
          </div>
        </div>

        <label>SKU</label>
        <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="optional — short code for receipts" />
        <div className="field-hint">
          short product code (e.g. ESP-DBL, MOMO-VEG).
        </div>

        <label>Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} />

        <label>Quick notes</label>
        <div className="preset-note-row">
          {presetNotes.map((n) => (
            <span key={n} className="chip active" style={{ display: 'inline-flex', gap: 6 }}>
              {n}
              <button
                type="button"
                className="chip-x"
                aria-label={`remove ${n}`}
                onClick={() => setPresetNotes(presetNotes.filter((p) => p !== n))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="row-inputs" style={{ marginBottom: 8 }}>
          <input
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="e.g. low sugar"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const v = noteDraft.trim();
                if (v && !presetNotes.includes(v)) setPresetNotes([...presetNotes, v]);
                setNoteDraft('');
              }
            }}
          />
          <button
            type="button"
            className="btn"
            onClick={() => {
              const v = noteDraft.trim();
              if (v && !presetNotes.includes(v)) setPresetNotes([...presetNotes, v]);
              setNoteDraft('');
            }}
            disabled={!noteDraft.trim()}
          >
            <Plus size={12} strokeWidth={1.5} /> Add
          </button>
        </div>
        <div className="field-hint">
          Shortcut notes a waiter can tap when adding this item (e.g. "low sugar", "no ice").
          Free-form notes still work.
        </div>

        {editing?.id && (
          <>
            <label>Status</label>
            <select value={active ? 'on' : 'off'} onChange={(e) => setActive(e.target.value === 'on')}>
              <option value="on">Active</option>
              <option value="off">Inactive</option>
            </select>

            <label>Inventory link (auto-deduct on close)</label>
            <div className="row-inputs">
              <select value={linkInvId} onChange={(e) => setLinkInvId(e.target.value)}>
                <option value="">— none —</option>
                {(inventoryItems.data ?? []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.sale_unit})
                  </option>
                ))}
              </select>
              <input
                value={linkQty}
                onChange={(e) => setLinkQty(e.target.value)}
                placeholder="qty per sale"
                disabled={!linkInvId}
              />
            </div>
            <div className="field-hint" style={{ marginTop: -8, marginBottom: 14 }}>
              when this menu item is sold and the order closes, we auto-deduct{' '}
              <strong>qty × qty-per-sale</strong> from the linked inventory item. example:
              one cigarette sale → −1 stick. tracks stock only — to capture cost in
              profitability, log a matching expense in <em>Expenses</em>.
            </div>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={pending || putLink.isPending}>
            {pending || putLink.isPending ? 'Saving…' : editing?.id ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------

/** Sync a form's local state with the latest "editing" target whenever it changes from null → value. */
function useSyncFormState<T>(editing: T | null, apply: (e: T | null) => void) {
  const last = useRef<T | null>(null);
  useEffect(() => {
    if (editing !== last.current) {
      apply(editing);
      last.current = editing;
    }
  }, [editing, apply]);
}
