/**
 * Inventory manager — stock items, item CRUD, adjustments, the per-item stock
 * ledger, and pack rules.
 *
 * Low stock and NEGATIVE stock are reported separately and never conflated.
 * Low means "order more"; negative means the book is wrong — more has been
 * sold than was ever recorded coming in — and a cafe that reads the second as
 * the first goes on trusting a count that cannot be true.
 */
import { memo, useState } from 'react';
import { View, Pressable, Alert, type TextInputProps } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Package, History, Boxes } from 'lucide-react-native';
import type { InventoryItem, InventoryKind, StockReason } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Stamp } from '@/components/ui/Stamp';
import { Chip } from '@/components/ui/Chip';
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
import { MovementsSheet } from '@/components/inventory/MovementsSheet';
import { PackRulesSheet } from '@/components/inventory/PackRulesSheet';
import { isNegativeStock, stockCounts, trimQty } from '@/inventory/stock';
import { toast } from '@/lib/toast';
import { parseQtyInput } from '@/lib/format';
import { errorText } from '@/lib/errorText';

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
  const [history, setHistory] = useState<InventoryItem | null>(null);
  const [packing, setPacking] = useState<InventoryItem | null>(null);

  const canManage = can(me.data, 'inventory:create') || can(me.data, 'inventory:update');
  const canAdjust = can(me.data, 'inventory:adjust');
  const canCreate = can(me.data, 'inventory:create');
  const canDelete = can(me.data, 'inventory:delete');
  if (me.data && !canManage && !canAdjust) return <Redirect href="/more" />;

  const rows = inventory.data ?? [];
  const counts = stockCounts(inventory.data);

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
      {/* Two badges, never one: "order more" and "the book is wrong" are
          different jobs, and a negative row is counted only as negative so
          the two never add up to more than the list. */}
      {counts.low > 0 || counts.negative > 0 ? (
        <View
          style={{
            flexDirection: 'row',
            gap: theme.spacing[2],
            paddingHorizontal: theme.spacing[5],
            paddingBottom: theme.spacing[2],
          }}
        >
          {counts.negative > 0 ? (
            <Stamp tone="danger" label={`${counts.negative} negative`} size="sm" />
          ) : null}
          {counts.low > 0 ? <Stamp tone="warn" label={`${counts.low} low`} size="sm" /> : null}
        </View>
      ) : null}

      {inventory.isLoading ? (
        <View style={{ gap: theme.spacing[3], paddingTop: theme.spacing[3], paddingHorizontal: theme.spacing[5] }}>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton.Card key={i} lines={1} />
          ))}
        </View>
      ) : inventory.isError && !inventory.data ? (
        <View style={{ paddingHorizontal: theme.spacing[5] }}>
          <ErrorState detail={errorText(inventory.error)} onRetry={() => void inventory.refetch()} />
        </View>
      ) : rows.length === 0 ? (
        <View style={{ paddingHorizontal: theme.spacing[5] }}>
          <EmptyState icon={<Package size={28} color={theme.colors.textMuted} />} title="No inventory items yet." />
        </View>
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(it) => it.id}
          contentContainerStyle={{
            paddingTop: theme.spacing[3],
            paddingHorizontal: theme.spacing[5],
            paddingBottom: insets.bottom + theme.spacing[10],
          }}
          renderItem={({ item: it }) => (
            <InventoryRow
              item={it}
              canManage={canManage}
              canAdjust={canAdjust}
              onEdit={setForm}
              onAdjust={setAdjust}
              onHistory={setHistory}
              onPackRules={setPacking}
            />
          )}
        />
      )}

      {form ? <ItemForm entity={form} onClose={() => setForm(null)} /> : null}
      {adjust ? <AdjustForm item={adjust} onClose={() => setAdjust(null)} /> : null}
      {history ? <MovementsSheet item={history} onClose={() => setHistory(null)} /> : null}
      {packing ? (
        <PackRulesSheet
          item={packing}
          canEdit={canCreate}
          canDelete={canDelete}
          onClose={() => setPacking(null)}
        />
      ) : null}
    </View>
  );
}

/** One stock line. Memoized so scrolling only renders newly-visible rows. */
const InventoryRow = memo(function InventoryRow({
  item,
  canManage,
  canAdjust,
  onEdit,
  onAdjust,
  onHistory,
  onPackRules,
}: {
  item: InventoryItem;
  canManage: boolean;
  canAdjust: boolean;
  onEdit: (i: InventoryItem) => void;
  onAdjust: (i: InventoryItem) => void;
  onHistory: (i: InventoryItem) => void;
  onPackRules: (i: InventoryItem) => void;
}) {
  const theme = useTheme();
  const negative = isNegativeStock(item);
  // A negative row is already the worse news; stacking "Low" on top of it says
  // "order more" about a count that isn't trustworthy in the first place.
  const low = item.is_low_stock && !negative;

  return (
    <Card
      level={2}
      style={{
        gap: theme.spacing[2],
        marginBottom: theme.spacing[3],
        ...(negative
          ? { borderColor: theme.colors.dangerFg }
          : low
            ? { borderColor: theme.colors.stamp.warn.border }
            : null),
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}>
        {/* Stock names run long ("Coca Cola 500ml Bottle Crate") and the stamp
            plus the Adjust pill are both rigid, so uncapped this grew 3-line
            rows — which also fights FlashList's item-height estimate. */}
        <Pressable style={{ flex: 1, minWidth: 0 }} onPress={() => canManage && onEdit(item)}>
          <AppText style={{ fontFamily: theme.fonts.bodyMedium }} numberOfLines={1}>
            {item.name}
          </AppText>
          <AppText variant="faint" style={{ fontSize: theme.text.sm }} numberOfLines={1}>
            <MonoText size="sm" muted>
              {trimQty(item.qty_on_hand_units)}
            </MonoText>{' '}
            {item.sale_unit} · par{' '}
            <MonoText size="sm" muted>
              {trimQty(item.par_low_units)}
            </MonoText>
            {/* The SKU is how stock is found on a supplier's invoice; without
                it the phone couldn't tell two similarly-named items apart. */}
            {item.sku ? ` · ${item.sku}` : ''}
          </AppText>
        </Pressable>
        {negative ? <Stamp tone="danger" label="Negative" size="sm" /> : null}
        {low ? <Stamp tone="warn" label="Low" size="sm" /> : null}
        {canAdjust ? (
          <Pressable
            onPress={() => onAdjust(item)}
            accessibilityLabel={`adjust-${item.name}`}
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

      {negative ? (
        <AppText style={{ fontSize: theme.text.sm, color: theme.colors.dangerFg }}>
          More has been sold than was recorded coming in. Check the movements, then correct the
          count.
        </AppText>
      ) : null}

      <View style={{ flexDirection: 'row', gap: theme.spacing[2] }}>
        <Chip
          label="Movements"
          icon={<History size={13} color={theme.colors.textMuted} />}
          onPress={() => onHistory(item)}
          testID={`movements-${item.id}`}
        />
        <Chip
          label="Pack rules"
          icon={<Boxes size={13} color={theme.colors.textMuted} />}
          onPress={() => onPackRules(item)}
          testID={`pack-rules-${item.id}`}
        />
      </View>
    </Card>
  );
});

function ItemForm({ entity, onClose }: { entity: InventoryItem | 'new'; onClose: () => void }) {
  const theme = useTheme();
  const editing = entity !== 'new';
  const create = useCreateInventoryItem();
  const update = useUpdateInventoryItem();
  const del = useDeleteInventoryItem();

  const [name, setName] = useState(editing ? entity.name : '');
  const [sku, setSku] = useState(editing ? (entity.sku ?? '') : '');
  const [kind, setKind] = useState<InventoryKind>(editing ? entity.kind : 'retail');
  const [unit, setUnit] = useState(editing ? entity.sale_unit : '');
  const [parLow, setParLow] = useState(editing ? entity.par_low_units : '');
  const [notes, setNotes] = useState(editing ? entity.notes : '');

  const save = () => {
    if (!name.trim()) return toast.error('Name is required');
    if (!unit.trim()) return toast.error('Unit is required', 'e.g. bottle, kg, pcs');
    const par = parLow.trim() ? parseQtyInput(parLow) : '0';
    if (par === null) return toast.error('Low-stock must be a number', 'e.g. 0 or 2.5');
    // Low-stock is the level that fires the alert, so a negative threshold
    // describes an alert that can never trigger.
    if (par.startsWith('-')) return toast.error('Low-stock cannot be negative', 'use 0 for no alert');
    const patch: Partial<InventoryItem> = {
      name: name.trim(),
      // null, not '': the column is uniquely indexed, so two items saved with
      // an empty SKU would collide on the second one.
      sku: sku.trim() || null,
      kind,
      sale_unit: unit.trim(),
      par_low_units: par,
      notes: notes.trim(),
    };
    // The fetch layer throws a plain ApiError object, not an Error — reading
    // `.message` off it directly loses the API's own text (a duplicate name
    // arrives here as a 409 with a usable explanation).
    const done = {
      onSuccess: () => { toast.success('Saved'); onClose(); },
      onError: (e: unknown) => toast.error('Could not save', errorText(e)),
    };
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
        <SheetField
          label="SKU (optional)"
          value={sku}
          onChangeText={setSku}
          placeholder="Supplier code"
          autoCapitalize="characters"
        />
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
    if (!Number.isFinite(amt) || amt <= 0) return toast.error('Enter a quantity');
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
          label="Adjustment"
          value={dir}
          options={[{ value: 'add', label: 'Add stock' }, { value: 'remove', label: 'Remove' }]}
          onChange={(v) => {
            setDir(v);
            setReason(v === 'add' ? 'purchase' : 'waste');
          }}
        />
        <SheetField
          label={dir === 'add' ? `Units to add (${item.sale_unit})` : `Units to remove (${item.sale_unit})`}
          value={amount}
          onChangeText={setAmount}
          placeholder="0"
          keyboardType="decimal-pad"
          autoFocus
        />
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
