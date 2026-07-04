/**
 * Menu manager (M7) — categories + items CRUD on the Docket surface. Each
 * category is a heading row (tap to edit); its items list beneath as cards with
 * a tabular price + Featured/Hidden stamps. Tapping opens an AppSheet form.
 * Prices are entered with AmountInput and stored as cents. Image upload + bulk
 * import are tracked follow-ups.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, Alert } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Pencil, QrCode, BookOpen } from 'lucide-react-native';
import type { MenuCategory, MenuItem, KitchenBehavior } from '@cafe-mgmt/api-types';
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
import { ToggleRow, SegmentedField } from '@/components/ui/Field';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useMenuCategories, useMenuItems } from '@/api/menu';
import {
  useCreateMenuCategory,
  useUpdateMenuCategory,
  useDeleteMenuCategory,
  useCreateMenuItem,
  useUpdateMenuItem,
  useDeleteMenuItem,
} from '@/api/menuAdmin';
import { formatNPR } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useTenantStore } from '@/stores/tenant';
import { ShareMenuSheet } from '@/components/menu/ShareMenuSheet';

const BEHAVIORS: { value: KitchenBehavior; label: string }[] = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'cook', label: 'Cook' },
  { value: 'ready', label: 'Ready' },
  { value: 'serve', label: 'Serve' },
];

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

  const canManage = can(me.data, 'menu:create') || can(me.data, 'menu:update');
  if (me.data && !canManage) return <Redirect href="/more" />;

  const cats = [...(categories.data ?? [])].sort((a, b) => a.sort - b.sort);
  const itemsByCat = (id: string) =>
    (items.data ?? []).filter((i) => i.category_id === id).sort((a, b) => a.sort - b.sort);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader
        title="Menu"
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}>
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
      <ScrollView
        contentContainerStyle={{
          paddingTop: theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[5],
        }}
      >
        {categories.isLoading ? (
          <View style={{ gap: theme.spacing[4] }}>
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton.Card key={i} lines={2} />
            ))}
          </View>
        ) : categories.isError ? (
          <ErrorState
            detail={String(categories.error)}
            onRetry={() => {
              void categories.refetch();
              void items.refetch();
            }}
          />
        ) : cats.length === 0 ? (
          <EmptyState
            icon={<BookOpen size={28} color={theme.colors.textMuted} />}
            title="No categories yet"
            hint="Tap + to add one."
          />
        ) : (
          cats.map((c) => (
            <View key={c.id} style={{ gap: theme.spacing[2] }}>
              <ListRow
                title={c.name}
                left={c.icon ? <AppIcon name={c.icon} size={18} color={theme.colors.primary} /> : undefined}
                right={
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
                    {c.is_active ? null : <Stamp tone="neutral" label="Hidden" size="sm" />}
                    <Pencil size={14} color={theme.colors.textFaint} />
                  </View>
                }
                onPress={() => setCatForm(c)}
              />

              {itemsByCat(c.id).map((it) => (
                <Card
                  key={it.id}
                  level={2}
                  onPress={() => setItemForm(it)}
                  accessibilityLabel={it.name}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing[3],
                    opacity: it.is_active ? 1 : 0.55,
                  }}
                >
                  <AppIcon name={it.icon} size={18} color={theme.colors.primary} />
                  <AppText style={{ flex: 1, fontFamily: theme.fonts.bodyMedium }} numberOfLines={1}>
                    {it.name}
                  </AppText>
                  {it.is_featured ? <Stamp tone="brand" label="Featured" size="sm" /> : null}
                  <MonoText weight="medium">{formatNPR(it.price_cents)}</MonoText>
                </Card>
              ))}

              <ListRow
                title="Add item"
                left={<Plus size={16} color={theme.colors.textMuted} />}
                onPress={() => setItemForm({ new: true, categoryId: c.id })}
              />
            </View>
          ))
        )}
      </ScrollView>

      {catForm ? <CategoryForm entity={catForm} onClose={() => setCatForm(null)} /> : null}
      {itemForm ? <ItemForm entity={itemForm} categories={cats} onClose={() => setItemForm(null)} /> : null}
      {shareOpen && active ? <ShareMenuSheet slug={active.slug} cafeName={active.name} onClose={() => setShareOpen(false)} /> : null}
    </View>
  );
}

/** Labeled text input for use inside an AppSheet (keeps gorhom's keyboard
 * tracking working — this is the money-field keyboard fix's sibling rule). */
function SheetTextField({
  label,
  value,
  onChangeText,
  placeholder,
  autoFocus = false,
  multiline = false,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  multiline?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing[2] }}>
      <AppText variant="label">{label}</AppText>
      <AppSheet.TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textFaint}
        accessibilityLabel={label}
        autoFocus={autoFocus}
        multiline={multiline}
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

  const [name, setName] = useState(editing ? entity.name : '');
  const [icon, setIcon] = useState(editing ? entity.icon : '');
  const [active, setActive] = useState(editing ? entity.is_active : true);

  const save = () => {
    if (!name.trim()) return toast.error('Name is required');
    const patch = { name: name.trim(), icon, is_active: active };
    const done = { onSuccess: () => { toast.success('Saved'); onClose(); }, onError: (e: Error) => toast.error('Could not save', e.message) };
    if (editing) update.mutate({ id: entity.id, patch }, done);
    else create.mutate(patch, done);
  };

  const confirmDelete = () => {
    if (!editing) return;
    Alert.alert('Delete category?', `"${entity.name}" and its layout. Items must be moved or removed first.`, [
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
        <SheetTextField label="Name" value={name} onChangeText={setName} placeholder="e.g. Hot Beverages" autoFocus={!editing} />
        <IconPickerField label="Icon" value={icon} onChange={setIcon} />
        <ToggleRow label="Visible" hint="Hidden categories don't show in the POS or public menu" value={active} onValueChange={setActive} />
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

  const save = () => {
    if (!name.trim()) return toast.error('Name is required');
    if (priceCents <= 0) return toast.error('Enter a price greater than 0');
    const patch: Partial<MenuItem> = {
      name: name.trim(),
      category_id: categoryId,
      price_cents: priceCents,
      cost_cents: costCents > 0 ? costCents : null,
      icon,
      kitchen_behavior: behavior,
      description: description.trim(),
      is_active: active,
      is_featured: featured,
      allow_half: allowHalf,
    };
    const done = { onSuccess: () => { toast.success('Saved'); onClose(); }, onError: (e: Error) => toast.error('Could not save', e.message) };
    if (editing) update.mutate({ id: entity.id, patch }, done);
    else create.mutate(patch, done);
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
          <Button title="Save" onPress={save} loading={create.isPending || update.isPending} />
          {editing ? <Button title="Delete" variant="ghost" onPress={confirmDelete} /> : null}
        </View>
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[6] }}
      >
        <SheetTextField label="Name" value={name} onChangeText={setName} placeholder="e.g. Cappuccino" autoFocus={!editing} />
        <SegmentedField
          label="Category"
          value={categoryId}
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCategoryId}
        />
        <AmountInput label="Price" valueCents={priceCents} onChangeCents={setPriceCents} insideSheet />
        <AmountInput label="Cost (optional)" valueCents={costCents} onChangeCents={setCostCents} insideSheet />
        <IconPickerField label="Icon" value={icon} onChange={setIcon} />
        <SegmentedField label="Kitchen routing" value={behavior} options={BEHAVIORS} onChange={setBehavior} />
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
      </AppSheet.ScrollView>
    </AppSheet>
  );
}
