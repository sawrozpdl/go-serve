/**
 * Inventory manager (M7) — stock items with low-stock flags, item CRUD, and
 * stock adjustments (add / remove with a reason). Pack-rules and menu-item
 * links are tracked follow-ups.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, Alert } from 'react-native';
import { useRouter, Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Plus, TriangleAlert } from 'lucide-react-native';
import type { InventoryItem, InventoryKind, StockReason } from '@cafe-mgmt/api-types';
import { Heading, AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Sheet } from '@/components/ui/Sheet';
import { SegmentedField } from '@/components/ui/Field';
import { useTheme, hexToRgba } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import {
  useInventory,
  useCreateInventoryItem,
  useUpdateInventoryItem,
  useDeleteInventoryItem,
  useAdjustInventory,
} from '@/api/inventory';
import { parsePriceToCents } from '@/catalog/money';
import { toast } from '@/lib/toast';

const KINDS: { value: InventoryKind; label: string }[] = [
  { value: 'retail', label: 'Retail' },
  { value: 'ingredient', label: 'Ingredient' },
];

export default function InventoryManager() {
  const theme = useTheme();
  const router = useRouter();
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
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[3],
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
          <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="back">
            <ChevronLeft size={26} color={theme.colors.primary} />
          </Pressable>
          <Heading style={{ fontSize: 26, flex: 1 }}>Inventory</Heading>
          {canManage ? (
            <Pressable onPress={() => setForm('new')} hitSlop={10} accessibilityLabel="add-item">
              <Plus size={24} color={theme.colors.primary} />
            </Pressable>
          ) : null}
        </View>

        {inventory.isLoading ? (
          <AppText variant="faint">Loading…</AppText>
        ) : rows.length === 0 ? (
          <AppText variant="muted">No inventory items yet.</AppText>
        ) : (
          rows.map((it) => (
            <View
              key={it.id}
              style={{
                backgroundColor: theme.colors.card,
                borderRadius: theme.radii.md,
                borderWidth: 1,
                borderColor: it.is_low_stock ? hexToRgba(theme.colors.warnFgTile, 0.6) : theme.colors.border,
                paddingVertical: theme.spacing[3],
                paddingHorizontal: theme.spacing[4],
                gap: theme.spacing[2],
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
                <Pressable style={{ flex: 1 }} onPress={() => canManage && setForm(it)}>
                  <AppText style={{ fontFamily: theme.fonts.bodyMedium }}>{it.name}</AppText>
                  <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                    {it.qty_on_hand_units} {it.sale_unit} · par {it.par_low_units}
                  </AppText>
                </Pressable>
                {it.is_low_stock ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <TriangleAlert size={13} color={theme.colors.warnFgTile} />
                    <AppText style={{ color: theme.colors.warnFgTile, fontSize: theme.text.xs, fontFamily: theme.fonts.bodySemi }}>
                      Low
                    </AppText>
                  </View>
                ) : null}
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
              </View>
            </View>
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
    <Sheet open onClose={onClose} title={editing ? 'Edit item' : 'New item'}>
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <TextField label="Name" value={name} onChangeText={setName} placeholder="e.g. Cola 500ml" autoFocus={!editing} />
        <SegmentedField label="Kind" value={kind} options={KINDS} onChange={setKind} />
        <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
          <View style={{ flex: 1 }}>
            <TextField label="Unit" value={unit} onChangeText={setUnit} placeholder="bottle" autoCapitalize="none" />
          </View>
          <View style={{ flex: 1 }}>
            <TextField label="Low-stock at" value={parLow} onChangeText={setParLow} placeholder="0" keyboardType="decimal-pad" />
          </View>
        </View>
        <TextField label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="Supplier, size…" multiline />
        <Button title="Save" onPress={save} loading={create.isPending || update.isPending} />
        {editing ? <Button title="Delete" variant="ghost" onPress={confirmDelete} /> : null}
      </View>
    </Sheet>
  );
}

function AdjustForm({ item, onClose }: { item: InventoryItem; onClose: () => void }) {
  const theme = useTheme();
  const adjust = useAdjustInventory();
  const [dir, setDir] = useState<'add' | 'remove'>('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<StockReason>('purchase');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');

  const reasons: { value: StockReason; label: string }[] =
    dir === 'add'
      ? [{ value: 'purchase', label: 'Purchase' }, { value: 'adjust', label: 'Correction' }, { value: 'transfer', label: 'Transfer in' }]
      : [{ value: 'waste', label: 'Waste' }, { value: 'adjust', label: 'Correction' }, { value: 'transfer', label: 'Transfer out' }];

  const submit = () => {
    const amt = parseFloat(amount.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(amt) || amt <= 0) return toast.error('Enter an amount');
    const delta = (dir === 'remove' ? -amt : amt).toString();
    const costStr = cost.trim();
    adjust.mutate(
      {
        id: item.id,
        delta_units: delta,
        reason,
        notes: notes.trim(),
        unit_cost_cents: dir === 'add' && costStr ? parsePriceToCents(cost) : undefined,
      },
      {
        onSuccess: () => { toast.success(`${dir === 'add' ? 'Added' : 'Removed'} ${amt} ${item.sale_unit}`); onClose(); },
        onError: (e) => toast.error('Could not adjust', (e as Error).message),
      },
    );
  };

  return (
    <Sheet open onClose={onClose} title={`Adjust · ${item.name}`}>
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          On hand: {item.qty_on_hand_units} {item.sale_unit}
        </AppText>
        <SegmentedField
          value={dir}
          options={[{ value: 'add', label: 'Add stock' }, { value: 'remove', label: 'Remove' }]}
          onChange={(v) => {
            setDir(v);
            setReason(v === 'add' ? 'purchase' : 'waste');
          }}
        />
        <TextField label={`Amount (${item.sale_unit})`} value={amount} onChangeText={setAmount} placeholder="0" keyboardType="decimal-pad" autoFocus />
        <SegmentedField label="Reason" value={reason} options={reasons} onChange={setReason} />
        {dir === 'add' ? (
          <TextField label="Unit cost (optional)" value={cost} onChangeText={setCost} placeholder="per unit" keyboardType="decimal-pad" />
        ) : null}
        <TextField label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="Invoice #, reason…" multiline />
        <Button title="Record adjustment" onPress={submit} loading={adjust.isPending} />
      </View>
    </Sheet>
  );
}
