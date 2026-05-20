import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, ChevronLeft, Search, Layers, UtensilsCrossed } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { ColorField } from '@/components/ColorField';
import { useConfirm } from '@/components/ConfirmDialog';
import { formatNPR, parsePriceInput } from '@/components/Money';
import { IconPicker, IconGlyph } from '@/components/IconPicker';
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
  type ApiError,
  type MenuCategory,
  type MenuItem,
} from '@/lib/api';
import { toast } from '@/lib/toast';

export function MenuPage() {
  const cats = useMenuCategories();
  const [selectedCatId, setSelectedCatId] = useState<string | null>(null);
  // On phones we want the items view to take over once a category is
  // picked. `viewMode` collapses the layout to a single pane at narrow
  // widths; CSS handles the actual responsive flow.
  const [mobileShowItems, setMobileShowItems] = useState(false);

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
          <span className="eyebrow">Catalog</span>
          <h1>Menu</h1>
        </div>
      </div>

      <div className={`menu-split ${mobileShowItems ? 'show-items' : 'show-cats'}`}>
        <CategoriesPanel
          selectedId={selectedCatId}
          onSelect={(id) => {
            setSelectedCatId(id);
            setMobileShowItems(true);
          }}
        />
        <ItemsPanel
          selectedCatId={selectedCatId}
          onBack={() => setMobileShowItems(false)}
        />
      </div>
    </>
  );
}

// -------------------------------------------------------------------------
// Categories — independently scrolling left rail with icon + count chip.
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
    <div className="panel menu-cats-panel">
      <div className="panel-head">
        <h3>Categories</h3>
        <button
          type="button"
          className="btn primary"
          onClick={() => setEditing({ name: '', sort: (list.data?.length ?? 0) + 1, color: '', icon: '' })}
        >
          <Plus size={14} strokeWidth={1.5} /> New
        </button>
      </div>

      <div className="menu-cats-scroll">
        {list.isPending && <div className="empty-state">Loading…</div>}
        {list.data?.length === 0 && (
          <div className="empty-state">
            No categories yet.
            <br />
            Add one to start building the menu.
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
                  className="cat-icon"
                  style={{ color: c.color || undefined }}
                  aria-hidden
                >
                  <IconGlyph
                    name={c.icon}
                    color={c.color || undefined}
                    size={20}
                    fallback={<Layers size={18} strokeWidth={1.5} color={c.color || undefined} />}
                  />
                </span>
                <span className="cat-name">{c.name}</span>
                <span className="cat-count" title={`${c.item_count} item${c.item_count === 1 ? '' : 's'}`}>
                  {c.item_count}
                </span>
                {!c.is_active && <span className="pill">Off</span>}
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="btn icon"
                    onClick={() => setEditing(c)}
                    aria-label="Edit"
                  >
                    <Pencil size={14} strokeWidth={1.5} />
                  </button>
                  <button
                    type="button"
                    className="btn icon danger"
                    disabled={c.item_count > 0}
                    title={
                      c.item_count > 0
                        ? `Remove the ${c.item_count} item(s) in this category first`
                        : 'Delete category'
                    }
                    onClick={async () => {
                      if (c.item_count > 0) return;
                      const ok = await confirm({
                        title: 'Delete category?',
                        message: (
                          <>
                            Delete the <strong>{c.name}</strong> menu category? This cannot be undone.
                          </>
                        ),
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        await del.mutateAsync(c.id);
                      } catch (e) {
                        const err = e as ApiError;
                        toast.error(err.message || 'Could not delete category');
                      }
                    }}
                    aria-label="Delete"
                  >
                    <Trash2 size={14} strokeWidth={1.5} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

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
  const [icon, setIcon] = useState('');
  const [active, setActive] = useState(true);

  useSyncFormState(editing, (e) => {
    setName(e?.name ?? '');
    setSort(e?.sort ?? 0);
    setColor(e?.color ?? '');
    setIcon(e?.icon ?? '');
    setActive(e?.is_active ?? true);
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing?.id ? 'Edit category' : 'New category'}
      subtitle="Cost-center bucket for revenue + COGS roll-up"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit({
            name,
            sort,
            color: color || null,
            icon,
            is_active: active,
          });
        }}
      >
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />

        <label>Icon</label>
        <IconPicker value={icon} onChange={setIcon} compact />

        <label>Color</label>
        <ColorField value={color} onChange={setColor} allowEmpty />

        <label>Sort</label>
        <input
          type="number"
          value={sort}
          onChange={(e) => setSort(Number(e.target.value) || 0)}
        />

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
// Items — independently scrolling grid of cards. Falls back to a friendly
// empty state when no category is picked or the picked category is empty.
// -------------------------------------------------------------------------

function ItemsPanel({
  selectedCatId,
  onBack,
}: {
  selectedCatId: string | null;
  onBack: () => void;
}) {
  const cats = useMenuCategories();
  const items = useMenuItems(selectedCatId ?? undefined);
  const create = useCreateMenuItem();
  const update = useUpdateMenuItem();
  const del = useDeleteMenuItem();
  const confirm = useConfirm();

  const [editing, setEditing] = useState<Partial<MenuItem> | null>(null);
  const [search, setSearch] = useState('');

  const selectedCat = cats.data?.find((c) => c.id === selectedCatId);

  const filtered = (items.data ?? []).filter((m) =>
    search.trim() === '' ? true : m.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <div className="panel menu-items-panel">
      <div className="panel-head">
        <button
          type="button"
          className="btn icon menu-back-btn"
          onClick={onBack}
          aria-label="Back to categories"
        >
          <ChevronLeft size={16} strokeWidth={1.5} />
        </button>
        <h3 className="menu-items-title">
          {selectedCat ? (
            <>
              <IconGlyph name={selectedCat.icon} color={selectedCat.color || undefined} size={18} />
              <span>{selectedCat.name}</span>
            </>
          ) : (
            'Items'
          )}
        </h3>
        <div className="menu-items-actions">
          <div className="menu-search">
            <Search size={14} strokeWidth={1.5} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search items"
            />
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={!selectedCatId}
            title={!selectedCatId ? 'Pick a category first' : undefined}
            onClick={() =>
              setEditing({ category_id: selectedCatId ?? '', name: '', price_cents: 0, icon: '' })
            }
          >
            <Plus size={14} strokeWidth={1.5} /> New item
          </button>
        </div>
      </div>

      <div className="menu-items-scroll">
        {!selectedCatId && (
          <div className="empty-state empty-state-tall">
            <Layers size={28} strokeWidth={1.5} style={{ opacity: 0.5, marginBottom: 8 }} />
            <div>Pick a category on the left to see its items.</div>
          </div>
        )}

        {selectedCatId && items.isPending && (
          <div className="empty-state">Loading…</div>
        )}

        {selectedCatId && items.data?.length === 0 && (
          <div className="empty-state empty-state-tall">
            <Layers size={28} strokeWidth={1.5} style={{ opacity: 0.5, marginBottom: 8 }} />
            <div>No items in this category yet.</div>
            <div style={{ marginTop: 4 }}>Tap <strong>New item</strong> to add one.</div>
          </div>
        )}

        {selectedCatId && filtered.length === 0 && items.data && items.data.length > 0 && (
          <div className="empty-state">No items match "{search}".</div>
        )}

        {selectedCatId && filtered.length > 0 && (
          <div className="menu-grid">
            {filtered.map((m) => (
              <MenuItemCard
                key={m.id}
                item={m}
                catColor={selectedCat?.color || undefined}
                onEdit={() => setEditing(m)}
                onDelete={async () => {
                  const ok = await confirm({
                    title: 'Delete menu item?',
                    message: (
                      <>
                        Remove <strong>{m.name}</strong>{' '}
                        ({formatNPR(m.price_cents)}) from the menu? Past sales remain in reports.
                      </>
                    ),
                    danger: true,
                  });
                  if (ok) del.mutate(m.id);
                }}
              />
            ))}
          </div>
        )}
      </div>

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

function MenuItemCard({
  item,
  catColor,
  onEdit,
  onDelete,
}: {
  item: MenuItem;
  catColor?: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`menu-item-card ${!item.is_active ? 'inactive' : ''}`}>
      <div className="menu-item-glyph" style={catColor ? { color: catColor } : undefined}>
        <IconGlyph
          name={item.icon}
          size={26}
          color={catColor}
          fallback={<UtensilsCrossed size={22} strokeWidth={1.4} color={catColor} />}
        />
      </div>
      <div className="menu-item-body">
        <div className="menu-item-name">{item.name}</div>
        {item.description && (
          <div className="menu-item-desc">{item.description}</div>
        )}
        <div className="menu-item-meta">
          {item.sku && <span className="sku">{item.sku}</span>}
          {!item.is_active && <span className="pill">Off</span>}
        </div>
      </div>
      <div className="menu-item-price">{formatNPR(item.price_cents)}</div>
      <div className="menu-item-actions">
        <button type="button" className="btn icon" onClick={onEdit} aria-label="Edit">
          <Pencil size={14} strokeWidth={1.5} />
        </button>
        <button type="button" className="btn icon danger" onClick={onDelete} aria-label="Delete">
          <Trash2 size={14} strokeWidth={1.5} />
        </button>
      </div>
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
  const [icon, setIcon] = useState('');
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
    setIcon(e?.icon ?? '');
    setActive(e?.is_active ?? true);
    setPresetNotes(e?.preset_notes ?? []);
    setNoteDraft('');
  });

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
    <Modal open={open} onClose={onClose} title={editing?.id ? 'Edit item' : 'New item'} subtitle="Catalog">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const cents = parsePriceInput(priceText);
          if (cents == null) return;
          const costRaw = costText.trim();
          const costCents = costRaw === '' ? undefined : parsePriceInput(costRaw);
          if (costRaw !== '' && costCents == null) return;
          await onSubmit({
            name,
            category_id: categoryId,
            description,
            price_cents: cents,
            cost_cents: costCents ?? null,
            sku: sku || null,
            icon,
            is_active: active,
            preset_notes: presetNotes,
          });
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

        <label>Icon</label>
        <IconPicker value={icon} onChange={setIcon} compact />

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
              placeholder="Optional, e.g. 30"
              value={costText}
              onChange={(e) => setCostText(e.target.value)}
            />
            <div className="field-hint">
              Your cost to make/buy one. Used in profitability — leave blank if you
              prefer to track cost via inventory + expenses only.
              {priceText && costText && parsePriceInput(priceText) && parsePriceInput(costText) ? (
                <>
                  {' '}
                  <strong style={{ color: 'var(--lime-fg)' }}>
                    Margin {(((parsePriceInput(priceText)! - parsePriceInput(costText)!) / parsePriceInput(priceText)!) * 100).toFixed(0)}%
                  </strong>{' '}
                  ({formatNPR((parsePriceInput(priceText)! - parsePriceInput(costText)!))} per sale)
                </>
              ) : null}
            </div>
          </div>
        </div>

        <label>SKU</label>
        <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="Optional — short code for receipts" />
        <div className="field-hint">
          Short product code (e.g. ESP-DBL, MOMO-VEG).
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
                aria-label={`Remove ${n}`}
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
                <option value="">— None —</option>
                {(inventoryItems.data ?? []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.sale_unit})
                  </option>
                ))}
              </select>
              <input
                value={linkQty}
                onChange={(e) => setLinkQty(e.target.value)}
                placeholder="Qty per sale"
                disabled={!linkInvId}
              />
            </div>
            <div className="field-hint" style={{ marginTop: -8, marginBottom: 14 }}>
              When this menu item is sold and the order closes, we auto-deduct{' '}
              <strong>qty × qty-per-sale</strong> from the linked inventory item. Example:
              one cigarette sale → −1 stick. Tracks stock only — to capture cost in
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

function useSyncFormState<T>(editing: T | null, apply: (e: T | null) => void) {
  const last = useRef<T | null>(null);
  useEffect(() => {
    if (editing !== last.current) {
      apply(editing);
      last.current = editing;
    }
  }, [editing, apply]);
}
