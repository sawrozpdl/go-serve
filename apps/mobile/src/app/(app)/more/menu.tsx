/**
 * Menu manager (M7) — categories + items CRUD on the Docket surface. Each
 * category is a heading row (tap to edit); its items list beneath as cards with
 * a tabular price + Featured/Hidden stamps. Tapping opens an AppSheet form.
 * Prices are entered with AmountInput and stored as cents. Image upload + bulk
 * import are tracked follow-ups.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { View, Pressable, TextInput, Alert, type KeyboardTypeOptions } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Pencil, QrCode, BookOpen, Upload } from 'lucide-react-native';
import type { MenuCategory, MenuItem, KitchenBehavior, ModifierGroup } from '@cafe-mgmt/api-types';
import { isValidName, NAME_HINT, NAME_MAX, normalizeName } from '@cafe-mgmt/validation';
import { bpToPctText, pctToBp } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import { Stamp } from '@/components/ui/Stamp';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { AmountInput } from '@/components/ui/AmountInput';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppIcon } from '@/components/ui/Icon';
import { IconPickerField } from '@/components/ui/IconPickerField';
import { ImageField } from '@/components/ui/ImageField';
import { ToggleRow, SegmentedField } from '@/components/ui/Field';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can, hasFeature } from '@/auth/permissions';
import { useMenuCategories, useMenuItems, useMenuItemLinks, usePutMenuItemLinks, useModifierGroups } from '@/api/menu';
import { useOutlets } from '@/api/outlets';
import { useUploadMenuImage } from '@/api/uploads';
import { useInventory } from '@/api/inventory';
import { Chip } from '@/components/ui/Chip';
import {
  useCreateMenuCategory,
  useUpdateMenuCategory,
  useDeleteMenuCategory,
  useCreateMenuItem,
  useUpdateMenuItem,
  useDeleteMenuItem,
  usePutItemModifierGroups,
  usePutCategoryModifierGroups,
} from '@/api/menuAdmin';
import {
  behaviorLabel,
  inheritedBehaviorLabel,
  resolveOutlet,
  defaultOutlet,
  outletLabel,
  itemMargin,
  matchesQuery,
} from '@/catalog/menuResolve';
import { groupRule } from '@/catalog/addOns';
import { formatNPR } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useTenantStore } from '@/stores/tenant';
import { ShareMenuSheet } from '@/components/menu/ShareMenuSheet';
import { BulkImportSheet } from '@/components/menu/BulkImportSheet';
import { errorText } from '@/lib/errorText';

/** A flattened row in the virtualized catalog list. */
type MenuRow =
  | { kind: 'category'; key: string; cat: MenuCategory; first: boolean }
  | { kind: 'item'; key: string; item: MenuItem }
  | { kind: 'add'; key: string; categoryId: string };

/** Every routing spelled out as the instruction it is. "Cook"/"Ready"/"Serve"
 *  told an operator nothing about what the kitchen would actually see. */
const BEHAVIORS: { value: KitchenBehavior; label: string }[] = (
  ['inherit', 'cook', 'ready', 'serve'] as KitchenBehavior[]
).map((value) => ({ value, label: behaviorLabel(value) }));

/** The routing options for an ITEM, whose "Inherit" can name its category. */
function itemBehaviors(category: MenuCategory | undefined): { value: KitchenBehavior; label: string }[] {
  return BEHAVIORS.map((b) =>
    b.value === 'inherit' ? { ...b, label: inheritedBehaviorLabel(category) } : b,
  );
}

export default function MenuManager() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const categories = useMenuCategories();
  const items = useMenuItems();

  const active = useTenantStore((s) => s.active);
  const [catForm, setCatForm] = useState<MenuCategory | 'new' | null>(null);
  const [itemForm, setItemForm] = useState<MenuItem | { new: true; categoryId: string } | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [importOpen, setImportOpen] = useState(false);

  const cats = useMemo(
    () => [...(categories.data ?? [])].sort((a, b) => a.sort - b.sort),
    [categories.data],
  );

  // One flat row list for the virtualizer. Grouping items by category once here
  // is also what keeps this O(items) instead of the O(categories × items) that a
  // per-category `.filter()` inside the render loop cost.
  const searching = query.trim().length > 0;

  const rows = useMemo<MenuRow[]>(() => {
    const byCat = new Map<string, MenuItem[]>();
    for (const it of items.data ?? []) {
      if (!matchesQuery(it, query)) continue;
      const bucket = byCat.get(it.category_id);
      if (bucket) bucket.push(it);
      else byCat.set(it.category_id, [it]);
    }
    for (const bucket of byCat.values()) bucket.sort((a, b) => a.sort - b.sort);

    const out: MenuRow[] = [];
    for (const c of cats) {
      const inCat = byCat.get(c.id) ?? [];
      // While searching, a category with no matches is noise — and so is its
      // "Add item" row, which would file the new item under a heading the
      // operator only reached by typing something else.
      if (searching && inCat.length === 0) continue;
      out.push({ kind: 'category', key: `c:${c.id}`, cat: c, first: out.length === 0 });
      for (const it of inCat) out.push({ kind: 'item', key: `i:${it.id}`, item: it });
      if (!searching) out.push({ kind: 'add', key: `a:${c.id}`, categoryId: c.id });
    }
    return out;
  }, [cats, items.data, query, searching]);

  // Permission redirect AFTER every hook — bailing earlier would make the hook
  // order depend on `me.data` arriving.
  const canManage = can(me.data, 'menu:create') || can(me.data, 'menu:update');
  // Plan-gated, exactly as web gates it: the endpoint 403s without the
  // feature, so offering the button would only ever produce an error.
  const canImport = can(me.data, 'menu:create') && hasFeature(me.data, 'menu_import');
  if (me.data && !canManage) return <Redirect href="/more" />;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader
        title="Menu"
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}>
            {canImport ? (
              <Pressable onPress={() => setImportOpen(true)} hitSlop={10} accessibilityLabel="import-menu">
                <Upload size={22} color={theme.colors.textMuted} />
              </Pressable>
            ) : null}
            {active ? (
              <Pressable onPress={() => setShareOpen(true)} hitSlop={10} accessibilityLabel="share-menu">
                <QrCode size={22} color={theme.colors.primary} />
              </Pressable>
            ) : null}
            <Pressable onPress={() => setCatForm('new')} hitSlop={10} accessibilityLabel="add-category">
              <Plus size={24} color={theme.colors.primary} />
            </Pressable>
          </View>
        }
      />
      {cats.length > 0 ? (
        <View style={{ paddingHorizontal: theme.spacing[5], paddingBottom: theme.spacing[3] }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search the menu"
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="search-menu"
            returnKeyType="search"
            style={{
              color: theme.colors.text,
              backgroundColor: theme.colors.surfaces[2],
              borderRadius: theme.radii.md,
              borderWidth: 1,
              borderColor: theme.colors.border,
              paddingHorizontal: theme.spacing[4],
              paddingVertical: theme.spacing[3],
              fontFamily: theme.fonts.body,
            }}
          />
        </View>
      ) : null}

      {categories.isLoading ? (
        <View style={{ gap: theme.spacing[4], paddingTop: theme.spacing[3], paddingHorizontal: theme.spacing[5] }}>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton.Card key={i} lines={2} />
          ))}
        </View>
      ) : categories.isError && !categories.data ? (
        // Only take over the screen when there is nothing cached to show; a
        // failed background refresh should not hide a menu we already have.
        <View style={{ paddingHorizontal: theme.spacing[5] }}>
          <ErrorState
            detail={errorText(categories.error)}
            onRetry={() => {
              void categories.refetch();
              void items.refetch();
            }}
          />
        </View>
      ) : cats.length === 0 ? (
        <View style={{ paddingHorizontal: theme.spacing[5] }}>
          <EmptyState
            icon={<BookOpen size={28} color={theme.colors.textMuted} />}
            title="No categories yet"
            hint="Tap + to add one."
          />
        </View>
      ) : rows.length === 0 ? (
        <View style={{ paddingHorizontal: theme.spacing[5] }}>
          <EmptyState
            icon={<BookOpen size={28} color={theme.colors.textMuted} />}
            title="Nothing matches that."
            hint="Search covers item names, SKUs and descriptions."
            action={{ label: 'Clear search', onPress: () => setQuery('') }}
          />
        </View>
      ) : (
        // Virtualized: a 300-item catalog mounts only the visible rows, so the
        // cost of opening this screen no longer scales with the menu size.
        <FlashList
          data={rows}
          keyExtractor={(r) => r.key}
          getItemType={(r) => r.kind}
          contentContainerStyle={{
            paddingTop: theme.spacing[3],
            paddingHorizontal: theme.spacing[5],
            paddingBottom: insets.bottom + theme.spacing[10],
          }}
          renderItem={({ item: row }) =>
            row.kind === 'category' ? (
              <CategoryRow cat={row.cat} first={row.first} onEdit={setCatForm} />
            ) : row.kind === 'item' ? (
              <ItemRow item={row.item} onEdit={setItemForm} />
            ) : (
              <AddItemRow categoryId={row.categoryId} onAdd={setItemForm} />
            )
          }
        />
      )}

      {catForm ? <CategoryForm entity={catForm} onClose={() => setCatForm(null)} /> : null}
      {itemForm ? <ItemForm entity={itemForm} categories={cats} onClose={() => setItemForm(null)} /> : null}
      {importOpen ? <BulkImportSheet onClose={() => setImportOpen(false)} /> : null}
      {shareOpen && active ? <ShareMenuSheet slug={active.slug} cafeName={active.name} onClose={() => setShareOpen(false)} /> : null}
    </View>
  );
}

/* ── Virtualized catalog rows ──────────────────────────────────────────────
   Memoized so scrolling (and any parent re-render) only re-renders the rows
   whose data actually changed. The `onEdit`/`onAdd` props are the raw state
   setters, which are referentially stable, so memo genuinely holds. */

const CategoryRow = memo(function CategoryRow({
  cat,
  first,
  onEdit,
}: {
  cat: MenuCategory;
  first: boolean;
  onEdit: (c: MenuCategory) => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ marginTop: first ? 0 : theme.spacing[5], marginBottom: theme.spacing[2] }}>
      <ListRow
        title={cat.name}
        left={cat.icon ? <AppIcon name={cat.icon} size={18} color={theme.colors.primary} /> : undefined}
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
            {/* The count is also the delete rule: a category cannot go while
                anything is in it, so the number IS the explanation. */}
            <MonoText size="2xs" muted>
              {cat.item_count}
            </MonoText>
            {cat.is_active ? null : <Stamp tone="neutral" label="Hidden" size="sm" />}
            <Pencil size={14} color={theme.colors.textFaint} />
          </View>
        }
        onPress={() => onEdit(cat)}
      />
    </View>
  );
});

const ItemRow = memo(function ItemRow({
  item,
  onEdit,
}: {
  item: MenuItem;
  onEdit: (i: MenuItem) => void;
}) {
  const theme = useTheme();
  return (
    <Card
      level={2}
      onPress={() => onEdit(item)}
      accessibilityLabel={item.name}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[3],
        opacity: item.is_active ? 1 : 0.55,
        marginBottom: theme.spacing[2],
      }}
    >
      <AppIcon name={item.icon} size={18} color={theme.colors.primary} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText style={{ fontFamily: theme.fonts.bodyMedium }} numberOfLines={1}>
          {item.name}
        </AppText>
        {item.sku ? (
          <MonoText size="2xs" muted numberOfLines={1}>
            {item.sku}
          </MonoText>
        ) : null}
      </View>
      {item.is_featured ? <Stamp tone="brand" label="Featured" size="sm" /> : null}
      <MonoText weight="medium" numberOfLines={1} style={{ flexShrink: 0 }}>
        {formatNPR(item.price_cents)}
      </MonoText>
    </Card>
  );
});

const AddItemRow = memo(function AddItemRow({
  categoryId,
  onAdd,
}: {
  categoryId: string;
  onAdd: (e: { new: true; categoryId: string }) => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ marginBottom: theme.spacing[2] }}>
      <ListRow
        title="Add item"
        left={<Plus size={16} color={theme.colors.textMuted} />}
        onPress={() => onAdd({ new: true, categoryId })}
      />
    </View>
  );
});

/** Labeled text input for use inside an AppSheet (keeps gorhom's keyboard
 * tracking working — this is the money-field keyboard fix's sibling rule). */
function SheetTextField({
  label,
  value,
  onChangeText,
  placeholder,
  autoFocus = false,
  multiline = false,
  keyboardType,
  maxLength,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  multiline?: boolean;
  keyboardType?: KeyboardTypeOptions;
  maxLength?: number;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing[2] }}>
      <AppText variant="label">{label}</AppText>
      <AppSheet.TextInput
        value={value}
        onChangeText={onChangeText}
        maxLength={maxLength}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textFaint}
        accessibilityLabel={label}
        autoFocus={autoFocus}
        multiline={multiline}
        keyboardType={keyboardType}
        style={{
          color: theme.colors.text,
          backgroundColor: theme.colors.surfaces[2],
          borderRadius: theme.radii.md,
          borderWidth: 1,
          borderColor: theme.colors.border,
          paddingHorizontal: theme.spacing[4],
          paddingVertical: theme.spacing[4],
          fontFamily: theme.fonts.body,
          fontSize: theme.text.lg,
          minHeight: multiline ? 88 : 52,
        }}
      />
    </View>
  );
}

function CategoryForm({ entity, onClose }: { entity: MenuCategory | 'new'; onClose: () => void }) {
  const theme = useTheme();
  const editing = entity !== 'new';
  const create = useCreateMenuCategory();
  const update = useUpdateMenuCategory();
  const del = useDeleteMenuCategory();

  const outlets = useOutlets();

  const [name, setName] = useState(editing ? entity.name : '');
  const [icon, setIcon] = useState(editing ? entity.icon : '');
  const [active, setActive] = useState(editing ? entity.is_active : true);
  const [sort, setSort] = useState(editing ? String(entity.sort) : '0');
  const [behavior, setBehavior] = useState<KitchenBehavior>(
    editing ? entity.kitchen_behavior : 'inherit',
  );
  const [outletId, setOutletId] = useState(editing ? (entity.outlet_id ?? '') : '');
  const [imageUrl, setImageUrl] = useState(editing ? (entity.image_url ?? '') : '');
  const uploadImage = useUploadMenuImage();
  // Typed as a percent, stored as basis points. '' and '0' both mean none.
  const [discountPct, setDiscountPct] = useState(
    editing && entity.discount_percent_bp ? bpToPctText(entity.discount_percent_bp) : '',
  );

  const outletRows = outlets.data ?? [];
  const fallbackOutlet = defaultOutlet(outletRows);

  // Add-on groups attached to the whole category ("all drinks get an extra
  // shot"). Composes with each item's own — see resolveModifierGroups.
  const addOnGroups = useModifierGroups();
  const putCatGroups = usePutCategoryModifierGroups();
  const [groupIds, setGroupIds] = useState<string[]>(
    editing ? [...(entity.modifier_group_ids ?? [])] : [],
  );

  const save = () => {
    if (!isValidName(name)) return toast.error('Check the name', NAME_HINT);
    const patch = {
      name: normalizeName(name),
      icon,
      is_active: active,
      sort: parseInt(sort, 10) || 0,
      kitchen_behavior: behavior,
      // '' means inherit, which the server reads as NULL — sending the empty
      // string would fail the uuid parse.
      outlet_id: outletId || null,
      // Here '' is meaningful: it CLEARS the banner. (Different sentinel from
      // outlet_id above, which is a uuid column.)
      image_url: imageUrl,
      discount_percent_bp: pctToBp(discountPct),
    };
    const done = {
      onSuccess: () => { toast.success('Saved'); onClose(); },
      onError: (e: Error) => toast.error('Could not save', e.message),
    };
    if (editing) {
      // The attachment is its own idempotent whole-set PUT, so it goes
      // alongside the patch rather than inside it.
      update.mutate(
        { id: entity.id, patch },
        {
          onSuccess: () =>
            putCatGroups.mutate(
              { categoryId: entity.id, groupIds },
              {
                onSuccess: () => { toast.success('Saved'); onClose(); },
                onError: (e) => toast.error('Saved, but add-ons did not attach', errorText(e)),
              },
            ),
          onError: done.onError,
        },
      );
    } else create.mutate(patch, done);
  };

  const confirmDelete = () => {
    if (!editing) return;
    // The server refuses while items remain, so say so here rather than
    // opening a confirm whose only possible outcome is an error toast.
    if (entity.item_count > 0) {
      return toast.error(
        `${entity.name} still has ${entity.item_count} item${entity.item_count === 1 ? '' : 's'}`,
        'Move or delete them first — the category cannot go while anything is in it.',
      );
    }
    Alert.alert('Delete category?', `"${entity.name}" and its layout.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          del.mutate(entity.id, {
            onSuccess: () => { toast.success('Deleted'); onClose(); },
            onError: (e) => toast.error('Could not delete', (e as Error).message),
          }),
      },
    ]);
  };

  return (
    <AppSheet
      open
      onClose={onClose}
      title={editing ? 'Edit category' : 'New category'}
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2], gap: theme.spacing[2] }}>
          <Button title="Save" onPress={save} loading={create.isPending || update.isPending} />
          {editing ? <Button title="Delete" variant="ghost" onPress={confirmDelete} /> : null}
        </View>
      }
    >
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <SheetTextField
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="e.g. Hot Beverages"
          maxLength={NAME_MAX}
          autoFocus={!editing}
        />
        <IconPickerField label="Icon" value={icon} onChange={setIcon} />
        <ImageField
          label="Banner"
          hint="Shown on the public QR menu, above this category's items."
          value={imageUrl}
          onChange={setImageUrl}
          upload={uploadImage.mutateAsync}
        />
        <SheetTextField
          label="Sort order"
          value={sort}
          onChangeText={setSort}
          placeholder="0"
          keyboardType="number-pad"
          maxLength={4}
        />
        <SegmentedField
          label="Kitchen routing"
          value={behavior}
          options={BEHAVIORS}
          onChange={setBehavior}
        />
        {outletRows.length > 1 ? (
          <View style={{ gap: theme.spacing[2] }}>
            <SegmentedField
              label="Prep station"
              value={outletId}
              options={[
                { value: '', label: fallbackOutlet ? `Default (${fallbackOutlet.name})` : 'Default' },
                ...outletRows.map((o) => ({ value: o.id, label: o.name })),
              ]}
              onChange={setOutletId}
            />
            {/* The server routes to whatever this points at, active or not. */}
            {(() => {
              const resolved = resolveOutlet(
                { ...(editing ? entity : ({} as MenuCategory)), outlet_id: outletId || null } as MenuCategory,
                outletRows,
              );
              return resolved && !resolved.is_active ? (
                <AppText style={{ fontSize: theme.text.sm, color: theme.colors.stamp.warn.fg }}>
                  {outletLabel(resolved)} — tickets still route there, onto a board nobody is
                  watching.
                </AppText>
              ) : null;
            })()}
          </View>
        ) : null}
        <SheetTextField
          label="Promotion discount (% off)"
          value={discountPct}
          onChangeText={setDiscountPct}
          placeholder="0"
          keyboardType="decimal-pad"
          maxLength={5}
        />
        <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
          Comes off every bill automatically, on this category&apos;s items only.
          Leave blank for no promotion. Tabs already running are updated; bills
          already settled are never re-priced. The service charge still applies.
        </AppText>
        <ToggleRow label="Visible" hint="Hidden categories don't show in the POS or public menu" value={active} onValueChange={setActive} />
        {editing ? (
          <AddOnPicker
            label="Add-ons for every item here"
            hint="Offered on every item in this category, on top of each item's own."
            groups={addOnGroups.data ?? []}
            selected={groupIds}
            onToggle={setGroupIds}
          />
        ) : null}
      </View>
    </AppSheet>
  );
}

function ItemForm({
  entity,
  categories,
  onClose,
}: {
  entity: MenuItem | { new: true; categoryId: string };
  categories: MenuCategory[];
  onClose: () => void;
}) {
  const theme = useTheme();
  const editing = !('new' in entity);
  const create = useCreateMenuItem();
  const update = useUpdateMenuItem();
  const del = useDeleteMenuItem();

  // Inventory links (auto-deduct on sale) — edit only; a new item has no id to
  // hang links on yet, so we prompt to save first.
  const inventory = useInventory();
  const linksQuery = useMenuItemLinks(editing ? entity.id : undefined);
  const putLinks = usePutMenuItemLinks();
  const [links, setLinks] = useState<{ inventory_item_id: string; qty_consumed_per_sale: string }[]>([]);
  const linksSeeded = useRef(false);
  useEffect(() => {
    if (editing && !linksSeeded.current && linksQuery.data) {
      setLinks(
        linksQuery.data.map((l) => ({
          inventory_item_id: l.inventory_item_id,
          qty_consumed_per_sale: l.qty_consumed_per_sale,
        })),
      );
      linksSeeded.current = true;
    }
  }, [editing, linksQuery.data]);

  const toggleLink = (invId: string) =>
    setLinks((prev) =>
      prev.some((l) => l.inventory_item_id === invId)
        ? prev.filter((l) => l.inventory_item_id !== invId)
        : [...prev, { inventory_item_id: invId, qty_consumed_per_sale: '1' }],
    );
  const setLinkQty = (invId: string, qty: string) =>
    setLinks((prev) =>
      prev.map((l) => (l.inventory_item_id === invId ? { ...l, qty_consumed_per_sale: qty } : l)),
    );

  const [name, setName] = useState(editing ? entity.name : '');
  const [categoryId, setCategoryId] = useState(editing ? entity.category_id : entity.categoryId);
  const [priceCents, setPriceCents] = useState(editing ? entity.price_cents : 0);
  const [costCents, setCostCents] = useState(editing ? entity.cost_cents ?? 0 : 0);
  const [icon, setIcon] = useState(editing ? entity.icon : '');
  const [behavior, setBehavior] = useState<KitchenBehavior>(editing ? entity.kitchen_behavior : 'inherit');
  const [description, setDescription] = useState(editing ? entity.description : '');
  const [active, setActive] = useState(editing ? entity.is_active : true);
  const [featured, setFeatured] = useState(editing ? entity.is_featured : false);
  const [allowHalf, setAllowHalf] = useState(editing ? entity.allow_half : false);
  const [sku, setSku] = useState(editing ? (entity.sku ?? '') : '');
  const [sort, setSort] = useState(editing ? String(entity.sort) : '0');
  const [outletId, setOutletId] = useState(editing ? (entity.outlet_id ?? '') : '');
  // One per line: a comma would rule out any note containing one, and these
  // are free text the waiter taps ("no chilli, extra hot").
  const [presetNotes, setPresetNotes] = useState(
    editing ? (entity.preset_notes ?? []).join('\n') : '',
  );
  const [imageUrl, setImageUrl] = useState(editing ? (entity.image_url ?? '') : '');
  const uploadImage = useUploadMenuImage();

  const outlets = useOutlets();
  const outletRows = outlets.data ?? [];
  const addOnGroups = useModifierGroups();
  const putItemGroups = usePutItemModifierGroups();
  const [groupIds, setGroupIds] = useState<string[]>(
    editing ? [...(entity.modifier_group_ids ?? [])] : [],
  );
  const selectedCat = categories.find((c) => c.id === categoryId);
  const inheritedOutlet = resolveOutlet(selectedCat, outletRows);
  const margin = itemMargin(priceCents, costCents);

  const save = async () => {
    if (!isValidName(name)) return toast.error('Check the name', NAME_HINT);
    if (priceCents <= 0) return toast.error('Enter a price greater than 0');
    const patch: Partial<MenuItem> = {
      name: normalizeName(name),
      category_id: categoryId,
      price_cents: priceCents,
      cost_cents: costCents > 0 ? costCents : null,
      icon,
      kitchen_behavior: behavior,
      description: description.trim(),
      is_active: active,
      is_featured: featured,
      allow_half: allowHalf,
      // null, not '': the column is uniquely indexed per tenant, so two items
      // saved with a blank SKU would collide on the second.
      sku: sku.trim() || null,
      sort: parseInt(sort, 10) || 0,
      outlet_id: outletId || null,
      image_url: imageUrl,
      preset_notes: presetNotes
        .split('\n')
        .map((n) => n.trim())
        .filter(Boolean),
    };
    try {
      if (editing) {
        await update.mutateAsync({ id: entity.id, patch });
        // Wholesale-replace the link set; drop blank/zero rows like web does.
        const clean = links.filter(
          (l) => l.inventory_item_id && (parseFloat(l.qty_consumed_per_sale) || 0) > 0,
        );
        await putLinks.mutateAsync({ menuItemId: entity.id, links: clean });
        // Whole-set PUT, idempotent. Composes with the category's groups
        // rather than replacing them.
        await putItemGroups.mutateAsync({ itemId: entity.id, groupIds });
      } else {
        await create.mutateAsync(patch);
      }
      toast.success('Saved');
      onClose();
    } catch (e) {
      toast.error('Could not save', (e as Error).message);
    }
  };

  const confirmDelete = () => {
    if (!editing) return;
    Alert.alert('Delete item?', `"${entity.name}" will be removed from the menu.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          del.mutate(entity.id, {
            onSuccess: () => { toast.success('Deleted'); onClose(); },
            onError: (e) => toast.error('Could not delete', (e as Error).message),
          }),
      },
    ]);
  };

  return (
    <AppSheet
      open
      onClose={onClose}
      title={editing ? 'Edit item' : 'New item'}
      full
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2], gap: theme.spacing[2] }}>
          <Button
            title="Save"
            onPress={save}
            loading={create.isPending || update.isPending || putLinks.isPending || putItemGroups.isPending}
          />
          {editing ? <Button title="Delete" variant="ghost" onPress={confirmDelete} /> : null}
        </View>
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[6] }}
      >
        <SheetTextField
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="e.g. Cappuccino"
          maxLength={NAME_MAX}
          autoFocus={!editing}
        />
        <SegmentedField
          label="Category"
          value={categoryId}
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCategoryId}
        />
        <AmountInput label="Price" valueCents={priceCents} onChangeCents={setPriceCents} insideSheet />
        <AmountInput label="Cost (optional)" valueCents={costCents} onChangeCents={setCostCents} insideSheet />
        {/* What the two numbers mean together. A negative margin is shown, not
            hidden: an item priced under cost is the thing worth catching. */}
        {margin ? (
          <AppText
            style={{
              fontSize: theme.text.sm,
              color: margin.pct < 0 ? theme.colors.dangerFg : theme.colors.successFg,
              fontFamily: theme.fonts.mono,
            }}
          >
            {margin.pct < 0 ? 'Loss' : 'Margin'} {margin.pct}% ·{' '}
            {formatNPR(Math.abs(margin.perSaleCents))} per sale
          </AppText>
        ) : null}
        <SheetTextField
          label="SKU (optional)"
          value={sku}
          onChangeText={setSku}
          placeholder="Short code for receipts"
        />
        <SheetTextField
          label="Sort order"
          value={sort}
          onChangeText={setSort}
          placeholder="0"
          keyboardType="number-pad"
          maxLength={4}
        />
        <IconPickerField label="Icon" value={icon} onChange={setIcon} />
        <ImageField
          label="Photo"
          hint="Shown on the public QR menu. The icon is what the POS uses."
          value={imageUrl}
          onChange={setImageUrl}
          upload={uploadImage.mutateAsync}
        />
        <SegmentedField
          label="Kitchen routing"
          value={behavior}
          options={itemBehaviors(selectedCat)}
          onChange={setBehavior}
        />
        {outletRows.length > 1 ? (
          <SegmentedField
            label="Prep station"
            value={outletId}
            options={[
              {
                value: '',
                label: inheritedOutlet ? `Inherit (${outletLabel(inheritedOutlet)})` : 'Inherit',
              },
              ...outletRows.map((o) => ({ value: o.id, label: o.name })),
            ]}
            onChange={setOutletId}
          />
        ) : null}
        <SheetTextField
          label="Preset notes (optional)"
          value={presetNotes}
          onChangeText={setPresetNotes}
          placeholder={'One per line\nno chilli\nextra hot'}
          multiline
        />
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          Tappable chips on the ticket when this item is added, so the common annotations don&apos;t
          have to be typed mid-service.
        </AppText>
        <SheetTextField
          label="Description (optional)"
          value={description}
          onChangeText={setDescription}
          placeholder="Shown on the public menu"
          multiline
        />
        <ToggleRow label="Available" hint="Off = hidden from ordering" value={active} onValueChange={setActive} />
        <ToggleRow label="Featured" hint="Pin into the Popular row" value={featured} onValueChange={setFeatured} />
        <ToggleRow label="Half plates" hint="Allow ½-plate steps (momo, chow mein)" value={allowHalf} onValueChange={setAllowHalf} />

        {editing ? (
          <AddOnPicker
            label="Add-ons"
            hint={
              (selectedCat?.modifier_group_ids?.length ?? 0) > 0
                ? "Offered on top of the category's own add-ons — the two combine, they do not replace each other."
                : 'Choices offered when this item is added to a tab.'
            }
            groups={addOnGroups.data ?? []}
            selected={groupIds}
            onToggle={setGroupIds}
          />
        ) : null}

        {/* Inventory links — auto-deduct stock when this item sells. */}
        {!editing ? (
          (inventory.data?.length ?? 0) > 0 ? (
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              Save the item first, then reopen it to link inventory (auto-deduct on sale).
            </AppText>
          ) : null
        ) : (inventory.data?.length ?? 0) > 0 ? (
          <View style={{ gap: theme.spacing[3] }}>
            <AppText variant="label">Inventory links</AppText>
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              Deduct stock automatically when this item sells. Tap to link, then set how much each
              sale uses.
            </AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
              {(inventory.data ?? []).map((inv) => (
                <Chip
                  key={inv.id}
                  label={inv.name}
                  selected={links.some((l) => l.inventory_item_id === inv.id)}
                  onPress={() => toggleLink(inv.id)}
                />
              ))}
            </View>
            {links.map((l) => {
              const inv = inventory.data?.find((i) => i.id === l.inventory_item_id);
              if (!inv) return null;
              return (
                <SheetTextField
                  key={l.inventory_item_id}
                  label={`${inv.name} — used per sale (${inv.sale_unit})`}
                  value={l.qty_consumed_per_sale}
                  onChangeText={(t) => setLinkQty(l.inventory_item_id, t)}
                  placeholder="1"
                  keyboardType="decimal-pad"
                />
              );
            })}
          </View>
        ) : null}
      </AppSheet.ScrollView>
    </AppSheet>
  );
}

/**
 * Attach reusable add-on groups.
 *
 * Chips rather than a list because reuse is the point — a cafe has a handful
 * of groups and attaches the same ones over and over. Each chip names the
 * group's pick rule, since "Milk" alone does not say whether the cashier is
 * forced to answer it.
 */
function AddOnPicker({
  label,
  hint,
  groups,
  selected,
  onToggle,
}: {
  label: string;
  hint: string;
  groups: ModifierGroup[];
  selected: string[];
  onToggle: (next: string[]) => void;
}) {
  const theme = useTheme();
  const usable = groups.filter((g) => g.is_active);
  if (usable.length === 0) {
    return (
      <View style={{ gap: theme.spacing[2] }}>
        <AppText variant="label">{label}</AppText>
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          No add-on groups yet. Create them in More → Add-ons, then attach them here.
        </AppText>
      </View>
    );
  }
  return (
    <View style={{ gap: theme.spacing[2] }}>
      <AppText variant="label">{label}</AppText>
      <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
        {hint}
      </AppText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
        {usable.map((g) => {
          const on = selected.includes(g.id);
          return (
            <Chip
              key={g.id}
              label={g.name}
              selected={on}
              onPress={() => onToggle(on ? selected.filter((id) => id !== g.id) : [...selected, g.id])}
              testID={`addon-${g.id}`}
            />
          );
        })}
      </View>
      {selected.length > 0 ? (
        <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
          {usable
            .filter((g) => selected.includes(g.id))
            .map((g) => `${g.name}: ${groupRule(g).toLowerCase()}`)
            .join(' · ')}
        </AppText>
      ) : null}
    </View>
  );
}
