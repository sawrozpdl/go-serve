import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, ChevronLeft, Layers, UtensilsCrossed, Flame, Star, QrCode } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { ColorField } from '@/components/ColorField';
import { useConfirm } from '@/components/ConfirmDialog';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { formatNPR, parsePriceInput } from '@/components/Money';
import { IconPicker, IconGlyph } from '@/components/IconPicker';
import { ImageUploadField } from '@/components/ImageUploadField';
import { PublicMenuShareModal } from '@/components/PublicMenuShareModal';
import { SearchInput } from '@/components/SearchInput';
import { InlineAddInput } from '@/components/InlineAddInput';
import { PageShell } from '@/components/PageShell';
import {
  useMenuCategories,
  useCreateMenuCategory,
  useUpdateMenuCategory,
  useDeleteMenuCategory,
  useMenuItems,
  usePopularMenuItems,
  useCreateMenuItem,
  useUpdateMenuItem,
  useDeleteMenuItem,
  useInventoryItems,
  useMenuItemLinks,
  usePutMenuItemLinks,
  useTenantSettings,
  type ApiError,
  type MenuCategory,
  type MenuItem,
} from '@/lib/api';
import { useTenant } from '@/lib/tenant';
import { usePermissions } from '@/lib/permissions';
import { toast } from '@/lib/toast';

export function MenuPage() {
  const cats = useMenuCategories();
  const { slug } = useTenant();
  const tenantSettings = useTenantSettings();
  const [selectedCatId, setSelectedCatId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
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
    <PageShell
      eyebrow="Catalog"
      title="Menu"
      className="page-shell--menu"
      actions={
        slug && (
          <button type="button" className="btn" onClick={() => setShareOpen(true)}>
            <QrCode size={14} strokeWidth={1.5} /> Public menu
          </button>
        )
      }
    >
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
      {slug && (
        <PublicMenuShareModal
          slug={slug}
          cafeName={tenantSettings.data?.name}
          open={shareOpen}
          onClose={() => setShareOpen(false)}
        />
      )}
    </PageShell>
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
  const popular = usePopularMenuItems(12);
  const create = useCreateMenuCategory();
  const update = useUpdateMenuCategory();
  const del = useDeleteMenuCategory();
  const confirm = useConfirm();
  const { can } = usePermissions();

  const [editing, setEditing] = useState<Partial<MenuCategory> | null>(null);

  return (
    <div className="panel menu-cats-panel">
      <div className="panel-head">
        <h3>Categories</h3>
        {can('menu:create') && (
          <button
            type="button"
            className="btn primary"
            onClick={() => setEditing({ name: '', sort: (list.data?.length ?? 0) + 1, color: '', icon: '' })}
          >
            <Plus size={14} strokeWidth={1.5} /> New
          </button>
        )}
      </div>

      <div className="menu-cats-scroll">
        {list.isPending && <LoadingState compact />}
        {list.isError && !list.data && <ErrorState compact onRetry={() => list.refetch()} />}
        {list.data?.length === 0 && (
          <div className="empty-state">
            No categories yet.
            <br />
            Add one to start building the menu.
          </div>
        )}

        {list.data && list.data.length > 0 && (
          <div className="cat-list">
            {/* "Frequently used" always renders so the operator can land on
             * it and pin items right away — the empty state inside explains
             * the philosophy when nothing is pinned and there's no history. */}
            <div
              key="__popular__"
              className={`cat-row ${selectedId === '__popular__' ? 'sel' : ''}`}
              onClick={() => onSelect('__popular__')}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect('__popular__');
                }
              }}
            >
              <span className="cat-icon" aria-hidden>
                <Flame size={18} strokeWidth={1.6} color="var(--amber-fg)" />
              </span>
              <span className="cat-name">Frequently used</span>
              <span
                className="cat-count"
                title={`${popular.data?.length ?? 0} item${
                  (popular.data?.length ?? 0) === 1 ? '' : 's'
                }`}
              >
                {popular.data?.length ?? 0}
              </span>
            </div>

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
                  {can('menu:update') && (
                    <button
                      type="button"
                      className="btn icon"
                      onClick={() => setEditing(c)}
                      aria-label="Edit"
                    >
                      <Pencil size={14} strokeWidth={1.5} />
                    </button>
                  )}
                  {can('menu:delete') && (
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
                  )}
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
  const [imageUrl, setImageUrl] = useState('');
  const [active, setActive] = useState(true);

  useSyncFormState(editing, (e) => {
    setName(e?.name ?? '');
    setSort(e?.sort ?? 0);
    setColor(e?.color ?? '');
    setIcon(e?.icon ?? '');
    setImageUrl(e?.image_url ?? '');
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
            image_url: imageUrl,
            is_active: active,
          });
        }}
      >
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />

        <label>Banner photo</label>
        <ImageUploadField
          value={imageUrl}
          onChange={setImageUrl}
          aspect="wide"
          hint="Optional. Shown as the section header on your public menu. A wide, well-lit photo works best."
        />

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
  const popularMode = selectedCatId === '__popular__';
  const items = useMenuItems(popularMode ? undefined : selectedCatId ?? undefined);
  const popular = usePopularMenuItems(24);
  const create = useCreateMenuItem();
  const update = useUpdateMenuItem();
  const del = useDeleteMenuItem();
  const confirm = useConfirm();
  const { can } = usePermissions();

  const [editing, setEditing] = useState<Partial<MenuItem> | null>(null);
  const [search, setSearch] = useState('');

  const selectedCat = cats.data?.find((c) => c.id === selectedCatId);
  const sourceItems: MenuItem[] = popularMode ? popular.data ?? [] : items.data ?? [];
  const sourcePending = popularMode ? popular.isPending : items.isPending;
  const sourceError = popularMode ? popular.isError : items.isError;
  const sourceData = popularMode ? popular.data : items.data;
  const filtered = sourceItems.filter((m) =>
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
          {popularMode ? (
            <>
              <Flame size={18} strokeWidth={1.6} color="var(--amber-fg)" />
              <span>Frequently used</span>
            </>
          ) : selectedCat ? (
            <>
              <IconGlyph name={selectedCat.icon} color={selectedCat.color || undefined} size={18} />
              <span>{selectedCat.name}</span>
            </>
          ) : (
            'Items'
          )}
        </h3>
        <div className="menu-items-actions">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search items"
            compact
          />
          {can('menu:create') && (
            <button
              type="button"
              className="btn primary"
              disabled={!selectedCatId || popularMode}
              title={
                !selectedCatId
                  ? 'Pick a category first'
                  : popularMode
                    ? 'Pick a category to add a new item'
                    : undefined
              }
              onClick={() =>
                setEditing({ category_id: selectedCatId ?? '', name: '', price_cents: 0, icon: '' })
              }
            >
              <Plus size={14} strokeWidth={1.5} /> New item
            </button>
          )}
        </div>
      </div>

      <div className="menu-items-scroll">
        {!selectedCatId && (
          <div className="empty-state empty-state-tall">
            <Layers size={28} strokeWidth={1.5} style={{ opacity: 0.5, marginBottom: 8 }} />
            <div>Pick a category on the left to see its items.</div>
          </div>
        )}

        {selectedCatId && sourcePending && <LoadingState />}

        {selectedCatId && sourceError && !sourceData && (
          <ErrorState onRetry={() => (popularMode ? popular.refetch() : items.refetch())} />
        )}

        {selectedCatId && !sourcePending && sourceData && sourceItems.length === 0 && (
          <div className="empty-state empty-state-tall">
            {popularMode ? (
              <>
                <Star size={28} strokeWidth={1.5} style={{ opacity: 0.5, marginBottom: 8 }} />
                <div>Nothing here yet.</div>
                <div style={{ marginTop: 4, maxWidth: 360 }}>
                  Pick a category on the left and tap the <Star size={12} strokeWidth={1.8} style={{ verticalAlign: '-2px' }} /> on any
                  item to pin it. Once orders start flowing, this list reranks by what's actually selling.
                </div>
              </>
            ) : (
              <>
                <Layers size={28} strokeWidth={1.5} style={{ opacity: 0.5, marginBottom: 8 }} />
                <div>No items in this category yet.</div>
                <div style={{ marginTop: 4 }}>Tap <strong>New item</strong> to add one.</div>
              </>
            )}
          </div>
        )}

        {selectedCatId && filtered.length === 0 && sourceItems.length > 0 && (
          <div className="empty-state">No items match "{search}".</div>
        )}

        {selectedCatId && filtered.length > 0 && (
          <div className="menu-grid">
            {filtered.map((m) => {
              const cat = popularMode ? cats.data?.find((c) => c.id === m.category_id) : selectedCat;
              return (
                <MenuItemCard
                  key={m.id}
                  item={m}
                  catColor={cat?.color || undefined}
                  onEdit={() => setEditing(m)}
                  onToggleFeatured={() =>
                    update.mutate({ id: m.id, patch: { is_featured: !m.is_featured } })
                  }
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
              );
            })}
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
  onToggleFeatured,
  onDelete,
}: {
  item: MenuItem;
  catColor?: string;
  onEdit: () => void;
  onToggleFeatured: () => void;
  onDelete: () => void;
}) {
  const { can } = usePermissions();
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
          {item.is_featured && (
            <span
              className="pill"
              style={{
                background: 'rgba(255, 176, 32, 0.14)',
                color: 'var(--amber-fg)',
              }}
            >
              Featured
            </span>
          )}
        </div>
      </div>
      <div className="menu-item-right">
        <div className="menu-item-price">{formatNPR(item.price_cents)}</div>
        <div className="menu-item-actions">
          {can('menu:update') && (
            <button
              type="button"
              className={`btn icon${item.is_featured ? ' active' : ''}`}
              onClick={onToggleFeatured}
              aria-label={item.is_featured ? 'Unpin from Frequently used' : 'Pin to Frequently used'}
              title={
                item.is_featured
                  ? 'Pinned to Frequently used — tap to unpin'
                  : 'Pin to Frequently used'
              }
              style={
                item.is_featured
                  ? { color: 'var(--amber-fg)', borderColor: 'rgba(255,176,32,0.4)' }
                  : undefined
              }
            >
              <Star
                size={14}
                strokeWidth={1.5}
                fill={item.is_featured ? 'currentColor' : 'none'}
              />
            </button>
          )}
          {can('menu:update') && (
            <button type="button" className="btn icon" onClick={onEdit} aria-label="Edit">
              <Pencil size={14} strokeWidth={1.5} />
            </button>
          )}
          {can('menu:delete') && (
            <button type="button" className="btn icon danger" onClick={onDelete} aria-label="Delete">
              <Trash2 size={14} strokeWidth={1.5} />
            </button>
          )}
        </div>
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
  const existingLinks = useMenuItemLinks(editing?.id ?? undefined);
  const putLinks = usePutMenuItemLinks();

  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [priceText, setPriceText] = useState('');
  const [costText, setCostText] = useState('');
  const [sku, setSku] = useState('');
  const [icon, setIcon] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [active, setActive] = useState(true);
  const [autoReady, setAutoReady] = useState(false);
  // One menu item can consume several inventory items per sale (e.g. a combo).
  const [links, setLinks] = useState<Array<{ inventory_item_id: string; qty_consumed_per_sale: string }>>([]);
  const [presetNotes, setPresetNotes] = useState<string[]>([]);

  useSyncFormState(editing, (e) => {
    setName(e?.name ?? '');
    setCategoryId(e?.category_id ?? categories[0]?.id ?? '');
    setDescription(e?.description ?? '');
    setPriceText(e?.price_cents != null ? (e.price_cents / 100).toString() : '');
    setCostText(e?.cost_cents != null ? (e.cost_cents / 100).toString() : '');
    setSku(e?.sku ?? '');
    setIcon(e?.icon ?? '');
    setImageUrl(e?.image_url ?? '');
    setActive(e?.is_active ?? true);
    setAutoReady(e?.auto_ready ?? false);
    setPresetNotes(e?.preset_notes ?? []);
  });

  useEffect(() => {
    if (existingLinks.data) {
      setLinks(
        existingLinks.data.map((l) => ({
          inventory_item_id: l.inventory_item_id,
          qty_consumed_per_sale: l.qty_consumed_per_sale,
        })),
      );
    }
  }, [existingLinks.data]);

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
            image_url: imageUrl,
            is_active: active,
            auto_ready: autoReady,
            preset_notes: presetNotes,
          });
          if (editing?.id) {
            // Replace the full set of links: drop blank rows, keep the rest.
            await putLinks.mutateAsync({
              menuItemId: editing.id,
              links: links
                .filter((l) => l.inventory_item_id)
                .map((l) => ({
                  inventory_item_id: l.inventory_item_id,
                  qty_consumed_per_sale: l.qty_consumed_per_sale || '1',
                })),
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

        <label>Photo</label>
        <ImageUploadField
          value={imageUrl}
          onChange={setImageUrl}
          aspect="square"
          hint="Optional. A single appetising photo shown on your public menu."
        />

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
        <div style={{ marginBottom: 8 }}>
          <InlineAddInput
            placeholder="e.g. low sugar"
            onAdd={(v) => {
              if (presetNotes.includes(v)) return false;
              setPresetNotes([...presetNotes, v]);
            }}
          />
        </div>
        <div className="field-hint">
          Shortcut notes a waiter can tap when adding this item (e.g. "low sugar", "no ice").
          Free-form notes still work.
        </div>

        <label>Kitchen</label>
        <select value={autoReady ? 'auto' : 'cook'} onChange={(e) => setAutoReady(e.target.value === 'auto')}>
          <option value="cook">Send to kitchen</option>
          <option value="auto">Skip kitchen — serve immediately</option>
        </select>
        <div className="field-hint">
          "Skip kitchen" hands the item straight to the customer when sent (no cooking
          step) and keeps it off the kitchen board. Use for cigarettes, packaged
          drinks, retail resell goods.
        </div>

        {editing?.id && (
          <>
            <label>Status</label>
            <select value={active ? 'on' : 'off'} onChange={(e) => setActive(e.target.value === 'on')}>
              <option value="on">Active</option>
              <option value="off">Inactive</option>
            </select>

            <label>Inventory links (auto-deduct on close)</label>
            {links.map((l, idx) => (
              <div className="row-inputs" key={idx} style={{ marginBottom: 8 }}>
                <select
                  value={l.inventory_item_id}
                  onChange={(e) =>
                    setLinks(links.map((x, i) => (i === idx ? { ...x, inventory_item_id: e.target.value } : x)))
                  }
                >
                  <option value="">— None —</option>
                  {(inventoryItems.data ?? []).map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.sale_unit})
                    </option>
                  ))}
                </select>
                <input
                  value={l.qty_consumed_per_sale}
                  onChange={(e) =>
                    setLinks(links.map((x, i) => (i === idx ? { ...x, qty_consumed_per_sale: e.target.value } : x)))
                  }
                  placeholder="Qty per sale"
                  disabled={!l.inventory_item_id}
                />
                <button
                  type="button"
                  className="btn icon danger"
                  aria-label="Remove inventory link"
                  onClick={() => setLinks(links.filter((_, i) => i !== idx))}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn"
              style={{ marginBottom: 10 }}
              onClick={() => setLinks([...links, { inventory_item_id: '', qty_consumed_per_sale: '1' }])}
            >
              + Add inventory link
            </button>
            <div className="field-hint" style={{ marginBottom: 14 }}>
              When this menu item is sold and the order closes, we auto-deduct{' '}
              <strong>qty × qty-per-sale</strong> from each linked inventory item. Example:
              one cigarette sale → −1 stick. Add more than one for combos that draw down
              several stock items. Tracks stock only — to capture cost in profitability,
              log a matching expense in <em>Expenses</em>.
            </div>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={pending || putLinks.isPending}>
            {pending || putLinks.isPending ? 'Saving…' : editing?.id ? 'Save' : 'Create'}
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
