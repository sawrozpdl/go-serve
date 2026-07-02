/**
 * Inventory manager (M7) — stock items with low-stock flags, item CRUD, and
 * stock adjustments (add / remove with a reason). Pack-rules and menu-item
 * links are tracked follow-ups.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, Alert, type TextInputProps } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Package } from 'lucide-react-native';
import type { InventoryItem, InventoryKind, StockReason } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Stamp } from '@/components/ui/Stamp';
import { AmountInput } from '@/components/ui/AmountInput';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { AppSheet } from '@/components/ui/AppSheet';
import { StackHeader } from '@/components/ui/StackHeader';
import { SegmentedField } from '@/components/ui/Field';
import { useTheme, type Theme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import {
  useInventory,
  useCreateInventoryItem,
  useUpdateInventoryItem,
  useDeleteInventoryItem,
  useAdjustInventory,
} from '@/api/inventory';
import { toast } from '@/lib/toast';

const KINDS: { value: InventoryKind; label: string }[] = [
  { value: 'retail', label: 'Retail' },
  { value: 'ingredient', label: 'Ingredient' },
];

export default function InventoryManager() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const inventory = useInventory();

  const [form, setForm] = useState<InventoryItem | 'new' | null>(null);
  const [adjust, setAdjust] = useState<InventoryItem | null>(null);

  const canManage = can(me.data, 'inventory:create') || can(me.data, 'inventory:update');
  const canAdjust = can(me.data, 'inventory:adjust');
  if (me.data && !canManage && !canAdjust) return <Redirect href="/more" />;

  const rows = inventory.data ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader
        title="Inventory"
        right={
          canManage ? (
            <Pressable onPress={() => setForm('new')} hitSlop={10} accessibilityLabel="add-item">
              <Plus size={24} color={theme.colors.primary} />
            </Pressable>
          ) : undefined
        }
      />
      <ScrollView
        contentContainerStyle={{
          paddingTop: theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[3],
        }}
      >
        {inventory.isLoading ? (
          <View style={{ gap: theme.spacing[3] }}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton.Card key={i} lines={1} />
            ))}
          </View>
        ) : inventory.isError ? (
          <ErrorState detail={String(inventory.error)} onRetry={() => void inventory.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Package size={28} color={theme.colors.textMuted} />} title="No inventory items yet." />
        ) : (
          rows.map((it) => (
            <Card
              key={it.id}
              level={2}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing[3],
                ...(it.is_low_stock ? { borderColor: theme.colors.stamp.warn.border } : null),
              }}
            >
              <Pressable style={{ flex: 1 }} onPress={() => canManage && setForm(it)}>
                <AppText style={{ fontFamily: theme.fonts.bodyMedium }}>{it.name}</AppText>
                <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                  <MonoText size="sm" muted>
                    {it.qty_on_hand_units}
                  </MonoText>{' '}
                  {it.sale_unit} · par{' '}
                  <MonoText size="sm" muted>
                    {it.par_low_units}
                  </MonoText>
                </AppText>
              </Pressable>
              {it.is_low_stock ? <Stamp tone="warn" label="Low" size="sm" /> : null}
              {canAdjust ? (
                <Pressable
                  onPress={() => setAdjust(it)}
                  accessibilityLabel={`adjust-${it.name}`}
                  style={{
                    paddingHorizontal: theme.spacing[3],
                    paddingVertical: theme.spacing[2],
                    borderRadius: theme.radii.pill,
                    borderWidth: 1,
                    borderColor: theme.colors.primary,
                  }}
                >
                  <AppText style={{ color: theme.colors.primary, fontSize: theme.text.sm, fontFamily: theme.fonts.bodySemi }}>
                    Adjust
                  </AppText>
                </Pressable>
              ) : null}
            </Card>
          ))
        )}
      </ScrollView>

      {form ? <ItemForm entity={form} onClose={() => setForm(null)} /> : null}
      {adjust ? <AdjustForm item={adjust} onClose={() => setAdjust(null)} /> : null}
    </View>
  );
}

function ItemForm({ entity, onClose }: { entity: InventoryItem | 'new'; onClose: () => void }) {
  const theme = useTheme();
  const editing = entity !== 'new';
  const create = useCreateInventoryItem();
  const update = useUpdateInventoryItem();
  const del = useDeleteInventoryItem();

  const [name, setName] = useState(editing ? entity.name : '');
  const [kind, setKind] = useState<InventoryKind>(editing ? entity.kind : 'retail');
  const [unit, setUnit] = useState(editing ? entity.sale_unit : '');
  const [parLow, setParLow] = useState(editing ? entity.par_low_units : '');
  const [notes, setNotes] = useState(editing ? entity.notes : '');

  const save = () => {
    if (!name.trim()) return toast.error('Name is required');
    if (!unit.trim()) return toast.error('Unit is required', 'e.g. bottle, kg, pcs');
    const patch: Partial<InventoryItem> = {
      name: name.trim(),
      kind,
      sale_unit: unit.trim(),
      par_low_units: parLow.trim() || '0',
      notes: notes.trim(),
    };
    const done = { onSuccess: () => { toast.success('Saved'); onClose(); }, onError: (e: Error) => toast.error('Could not save', e.message) };
    if (editing) update.mutate({ id: entity.id, patch }, done);
    else create.mutate(patch, done);
  };

  const confirmDelete = () => {
    if (!editing) return;
    Alert.alert('Delete item?', `"${entity.name}" and its stock history.`, [
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
        contentContainerStyle={{ paddingHorizontal: theme.spacing[5], paddingBottom: theme.spacing[6], gap: theme.spacing[4] }}
      >
        <SheetField label="Name" value={name} onChangeText={setName} placeholder="e.g. Cola 500ml" autoFocus={!editing} />
        <SegmentedField label="Kind" value={kind} options={KINDS} onChange={setKind} />
        <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
          <View style={{ flex: 1 }}>
            <SheetField label="Unit" value={unit} onChangeText={setUnit} placeholder="bottle" autoCapitalize="none" />
          </View>
          <View style={{ flex: 1 }}>
            <SheetField label="Low-stock at" value={parLow} onChangeText={setParLow} placeholder="0" keyboardType="decimal-pad" />
          </View>
        </View>
        <SheetField label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="Supplier, size…" multiline />
      </AppSheet.ScrollView>
    </AppSheet>
  );
}

function AdjustForm({ item, onClose }: { item: InventoryItem; onClose: () => void }) {
  const theme = useTheme();
  const adjust = useAdjustInventory();
  const [dir, setDir] = useState<'add' | 'remove'>('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<StockReason>('purchase');
  const [costCents, setCostCents] = useState(0);
  const [notes, setNotes] = useState('');

  const reasons: { value: StockReason; label: string }[] =
    dir === 'add'
      ? [{ value: 'purchase', label: 'Purchase' }, { value: 'adjust', label: 'Correction' }, { value: 'transfer', label: 'Transfer in' }]
      : [{ value: 'waste', label: 'Waste' }, { value: 'adjust', label: 'Correction' }, { value: 'transfer', label: 'Transfer out' }];

  const submit = () => {
    const amt = parseFloat(amount.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(amt) || amt <= 0) return toast.error('Enter an amount');
    const delta = (dir === 'remove' ? -amt : amt).toString();
    adjust.mutate(
      {
        id: item.id,
        delta_units: delta,
        reason,
        notes: notes.trim(),
        unit_cost_cents: dir === 'add' && costCents > 0 ? costCents : undefined,
      },
      {
        onSuccess: () => { toast.success(`${dir === 'add' ? 'Added' : 'Removed'} ${amt} ${item.sale_unit}`); onClose(); },
        onError: (e) => toast.error('Could not adjust', (e as Error).message),
      },
    );
  };

  return (
    <AppSheet
      open
      onClose={onClose}
      title={`Adjust · ${item.name}`}
      full
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] }}>
          <Button title="Record adjustment" onPress={submit} loading={adjust.isPending} />
        </View>
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{ paddingHorizontal: theme.spacing[5], paddingBottom: theme.spacing[6], gap: theme.spacing[4] }}
      >
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          On hand:{' '}
          <MonoText size="sm" muted>
            {item.qty_on_hand_units}
          </MonoText>{' '}
          {item.sale_unit}
        </AppText>
        <SegmentedField
          value={dir}
          options={[{ value: 'add', label: 'Add stock' }, { value: 'remove', label: 'Remove' }]}
          onChange={(v) => {
            setDir(v);
            setReason(v === 'add' ? 'purchase' : 'waste');
          }}
        />
        <SheetField label={`Amount (${item.sale_unit})`} value={amount} onChangeText={setAmount} placeholder="0" keyboardType="decimal-pad" autoFocus />
        <SegmentedField label="Reason" value={reason} options={reasons} onChange={setReason} />
        {dir === 'add' ? (
          <AmountInput label="Unit cost (optional)" valueCents={costCents} onChangeCents={setCostCents} insideSheet />
        ) : null}
        <SheetField label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="Invoice #, reason…" multiline />
      </AppSheet.ScrollView>
    </AppSheet>
  );
}

function fieldStyle(theme: Theme) {
  return {
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaces[2],
    borderRadius: theme.radii.md,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    fontFamily: theme.fonts.body,
    borderWidth: 1,
    borderColor: theme.colors.border,
  };
}

function SheetField({ label, ...props }: { label: string } & TextInputProps) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing[2] }}>
      <AppText variant="label">{label}</AppText>
      <AppSheet.TextInput placeholderTextColor={theme.colors.textFaint} style={fieldStyle(theme)} {...props} />
    </View>
  );
}
