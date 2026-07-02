/**
 * Menu manager (M7) — categories + items CRUD. Categories are cards; their
 * items list beneath with price + active/featured badges. Tapping opens a
 * bottom-sheet form. Prices are entered as decimals and stored as cents.
 * Image upload + bulk import are tracked follow-ups.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, Alert } from 'react-native';
import { useRouter, Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Plus, Pencil, QrCode } from 'lucide-react-native';
import type { MenuCategory, MenuItem, KitchenBehavior } from '@cafe-mgmt/api-types';
import { Heading, AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Sheet } from '@/components/ui/Sheet';
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
import { parsePriceToCents, centsToPriceInput } from '@/catalog/money';
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
  const router = useRouter();
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
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[4],
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
          <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="back">
            <ChevronLeft size={26} color={theme.colors.primary} />
          </Pressable>
          <Heading style={{ fontSize: 26, flex: 1 }}>Menu</Heading>
          {active ? (
            <Pressable onPress={() => setShareOpen(true)} hitSlop={10} accessibilityLabel="share-menu" style={{ marginRight: theme.spacing[3] }}>
              <QrCode size={22} color={theme.colors.primary} />
            </Pressable>
          ) : null}
          <Pressable onPress={() => setCatForm('new')} hitSlop={10} accessibilityLabel="add-category">
            <Plus size={24} color={theme.colors.primary} />
          </Pressable>
        </View>

        {categories.isLoading ? (
          <AppText variant="faint">Loading…</AppText>
        ) : cats.length === 0 ? (
          <AppText variant="muted">No categories yet. Tap + to add one.</AppText>
        ) : (
          cats.map((c) => (
            <View key={c.id} style={{ gap: theme.spacing[2] }}>
              <Pressable
                onPress={() => setCatForm(c)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2], paddingVertical: theme.spacing[1] }}
              >
                {c.icon ? <AppIcon name={c.icon} size={18} color={theme.colors.primary} /> : null}
                <AppText variant="label" style={{ flex: 1 }}>
                  {c.name}
                  {c.is_active ? '' : ' · hidden'}
                </AppText>
                <Pencil size={14} color={theme.colors.textFaint} />
              </Pressable>

              {itemsByCat(c.id).map((it) => (
                <Pressable
                  key={it.id}
                  onPress={() => setItemForm(it)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing[3],
                    backgroundColor: theme.colors.card,
                    borderRadius: theme.radii.md,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    paddingVertical: theme.spacing[3],
                    paddingHorizontal: theme.spacing[4],
                    opacity: it.is_active ? 1 : 0.55,
                  }}
                >
                  <AppIcon name={it.icon} size={18} color={theme.colors.primary} />
                  <AppText style={{ flex: 1, fontFamily: theme.fonts.bodyMedium }}>{it.name}</AppText>
                  {it.is_featured ? <AppText style={{ color: theme.colors.primary, fontSize: theme.text.xs }}>★</AppText> : null}
                  <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{formatNPR(it.price_cents)}</AppText>
                </Pressable>
              ))}

              <Pressable
                onPress={() => setItemForm({ new: true, categoryId: c.id })}
                hitSlop={6}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: theme.spacing[1] }}
              >
                <Plus size={14} color={theme.colors.textMuted} />
                <AppText style={{ color: theme.colors.textMuted, fontSize: theme.text.sm }}>Add item</AppText>
              </Pressable>
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
    <Sheet open onClose={onClose} title={editing ? 'Edit category' : 'New category'}>
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <TextField label="Name" value={name} onChangeText={setName} placeholder="e.g. Hot Beverages" autoFocus={!editing} />
        <IconPickerField label="Icon" value={icon} onChange={setIcon} />
        <ToggleRow label="Visible" hint="Hidden categories don't show in the POS or public menu" value={active} onValueChange={setActive} />
        <Button title="Save" onPress={save} loading={create.isPending || update.isPending} />
        {editing ? <Button title="Delete" variant="ghost" onPress={confirmDelete} /> : null}
      </View>
    </Sheet>
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
  const [price, setPrice] = useState(editing ? centsToPriceInput(entity.price_cents) : '');
  const [cost, setCost] = useState(editing ? centsToPriceInput(entity.cost_cents) : '');
  const [icon, setIcon] = useState(editing ? entity.icon : '');
  const [behavior, setBehavior] = useState<KitchenBehavior>(editing ? entity.kitchen_behavior : 'inherit');
  const [description, setDescription] = useState(editing ? entity.description : '');
  const [active, setActive] = useState(editing ? entity.is_active : true);
  const [featured, setFeatured] = useState(editing ? entity.is_featured : false);

  const save = () => {
    if (!name.trim()) return toast.error('Name is required');
    const priceCents = parsePriceToCents(price);
    if (priceCents <= 0) return toast.error('Enter a price greater than 0');
    const costStr = cost.trim();
    const patch: Partial<MenuItem> = {
      name: name.trim(),
      category_id: categoryId,
      price_cents: priceCents,
      cost_cents: costStr ? parsePriceToCents(cost) : null,
      icon,
      kitchen_behavior: behavior,
      description: description.trim(),
      is_active: active,
      is_featured: featured,
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
    <Sheet open onClose={onClose} title={editing ? 'Edit item' : 'New item'} full>
      <ScrollView contentContainerStyle={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[8] }}>
        <TextField label="Name" value={name} onChangeText={setName} placeholder="e.g. Cappuccino" autoFocus={!editing} />
        <SegmentedField
          label="Category"
          value={categoryId}
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
          onChange={setCategoryId}
        />
        <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
          <View style={{ flex: 1 }}>
            <TextField label="Price" value={price} onChangeText={setPrice} placeholder="0" keyboardType="decimal-pad" />
          </View>
          <View style={{ flex: 1 }}>
            <TextField label="Cost (optional)" value={cost} onChangeText={setCost} placeholder="—" keyboardType="decimal-pad" />
          </View>
        </View>
        <IconPickerField label="Icon" value={icon} onChange={setIcon} />
        <SegmentedField label="Kitchen routing" value={behavior} options={BEHAVIORS} onChange={setBehavior} />
        <TextField label="Description (optional)" value={description} onChangeText={setDescription} placeholder="Shown on the public menu" multiline />
        <ToggleRow label="Available" hint="Off = hidden from ordering" value={active} onValueChange={setActive} />
        <ToggleRow label="Featured" hint="Pin into the Popular row" value={featured} onValueChange={setFeatured} />
        <Button title="Save" onPress={save} loading={create.isPending || update.isPending} />
        {editing ? <Button title="Delete" variant="ghost" onPress={confirmDelete} /> : null}
      </ScrollView>
    </Sheet>
  );
}
