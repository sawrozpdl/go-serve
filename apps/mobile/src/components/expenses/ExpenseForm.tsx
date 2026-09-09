/**
 * Record or correct one expense.
 *
 * Two server rules shape the whole form and neither is discoverable at
 * runtime, so both are encoded here (see `EditableExpenseFields`):
 *
 *  - `allocations` is a pointer: omit it and the cost-centre split survives,
 *    send it and the split is replaced. Mobile has no allocation editor, so it
 *    never sends the key and a phone edit can't wipe a split set on the
 *    dashboard.
 *  - The money source, the owner and the inventory link are immutable. Edit
 *    mode therefore prints them instead of offering them, and says why.
 */
import { useState } from 'react';
import { View, Alert } from 'react-native';
import { Trash2, Boxes, ChevronLeft, ChevronRight } from 'lucide-react-native';
import type { Expense, ExpensePaidFrom } from '@cafe-mgmt/api-types';
import { AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { AppSheet } from '@/components/ui/AppSheet';
import { AmountInput } from '@/components/ui/AmountInput';
import { SegmentedField } from '@/components/ui/Field';
import { useTheme, type Theme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useCreateExpense, useUpdateExpense, useDeleteExpense, useExpenseCategories, useExpenseVendors } from '@/api/expenses';
import { useInventory } from '@/api/inventory';
import { formatNPR } from '@/lib/format';
import { toast } from '@/lib/toast';
import { errorText } from '@/lib/errorText';
import { todayStr, shiftDay, formatDayLabel, nowHHMM } from '@/lib/dates';
import { paidFromLabel, vendorSuggestions, paidAtIso, isValidHHMM } from '@/expenses/filters';
import { useExpenseFunding } from '@/expenses/useExpenseFunding';
import { PaidFromPicker } from './PaidFromPicker';

export function ExpenseForm({
  expense,
  onClose,
}: {
  /** null = recording a new expense; otherwise the row being edited. */
  expense: Expense | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const me = useMe();
  const create = useCreateExpense();
  const update = useUpdateExpense();
  const remove = useDeleteExpense();
  const categories = useExpenseCategories();
  const vendors = useExpenseVendors();
  const inventory = useInventory();
  const editing = !!expense;
  const funding = useExpenseFunding(me.data, true);

  const canDelete = can(me.data, 'expense:delete');
  const canReadInventory = can(me.data, 'inventory:read');

  const [amountCents, setAmountCents] = useState(expense?.amount_cents ?? 0);
  const [categoryId, setCategoryId] = useState<string>(expense?.expense_category_id ?? '');
  // Opens on the drawer: paying out of the till is the common case, and the
  // shift read has not answered yet at first render.
  const [paidFrom, setPaidFrom] = useState<ExpensePaidFrom>(expense?.paid_from ?? 'drawer');
  const [ownerId, setOwnerId] = useState<string>(expense?.owner_id ?? '');
  const [vendor, setVendor] = useState(expense?.vendor ?? '');
  const [referenceNo, setReferenceNo] = useState(expense?.reference_no ?? '');
  const [notes, setNotes] = useState(expense?.notes ?? '');
  // Editing keeps the recorded instant; recording opens on now.
  const [paidDay, setPaidDay] = useState(() => todayStr(expense ? new Date(expense.paid_at) : undefined));
  const [paidTime, setPaidTime] = useState(() => nowHHMM(expense ? new Date(expense.paid_at) : undefined));
  const [invId, setInvId] = useState('');
  const [units, setUnits] = useState('');

  // Once the shift read confirms there is no open drawer, move off it rather
  // than letting the operator submit into a 409 shift_required. Only on
  // evidence — see `drawerBlocked`. (Create only: an existing drawer expense
  // keeps its source, which is immutable anyway.)
  if (!editing && paidFrom === 'drawer' && funding.drawerBlocked) setPaidFrom('bank');

  // The owner chips have no "none", so preselect the first once they load.
  const needsOwner = paidFrom === 'owner' || paidFrom === 'owner_cash';
  if (!editing && needsOwner && !ownerId && funding.owners.length > 0) {
    setOwnerId(funding.owners[0].id);
  }

  const cats = categories.data ?? [];
  const invItems = inventory.data ?? [];
  const busy = create.isPending || update.isPending || remove.isPending;
  const suggestions = vendorSuggestions(vendors.data, vendor);
  const timeBad = !isValidHHMM(paidTime);

  const submit = () => {
    if (amountCents <= 0) return toast.error('Enter an amount');
    if (timeBad) return toast.error('Check the time', 'Use HH:MM, e.g. 14:30.');

    if (editing) {
      update.mutate(
        {
          id: expense.id,
          patch: {
            amount_cents: amountCents,
            expense_category_id: categoryId || null,
            clear_category: !categoryId,
            vendor: vendor.trim(),
            reference_no: referenceNo.trim(),
            notes: notes.trim(),
            paid_at: paidAtIso(paidDay, paidTime),
          },
        },
        {
          onSuccess: () => {
            toast.success('Expense updated');
            onClose();
          },
          onError: (e) => toast.error('Could not save', errorText(e)),
        },
      );
      return;
    }

    if (needsOwner && !ownerId) return toast.error('Pick an owner');
    if (invId && !units.trim()) {
      return toast.error('How many units?', 'Stock links need the quantity bought.');
    }

    create.mutate(
      {
        amount_cents: amountCents,
        expense_category_id: categoryId || null,
        paid_from: paidFrom,
        owner_id: needsOwner ? ownerId : null,
        vendor: vendor.trim(),
        reference_no: referenceNo.trim(),
        notes: notes.trim(),
        paid_at: paidAtIso(paidDay, paidTime),
        linked_inventory_item_id: invId || null,
        delta_units: invId ? units.trim() : undefined,
      },
      {
        onSuccess: () => {
          toast.success('Expense recorded');
          onClose();
        },
        onError: (e) => toast.error('Could not save', errorText(e)),
      },
    );
  };

  const confirmDelete = () => {
    if (!expense) return;
    Alert.alert(
      'Delete this expense?',
      expense.paid_from === 'drawer'
        ? 'The cash it took out of the drawer is given back, and the drawer total is recalculated.'
        : 'It stops counting against the cafe, and any balance it moved is given back.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            remove.mutate(expense.id, {
              onSuccess: () => {
                toast.success('Expense deleted');
                onClose();
              },
              onError: (e) => toast.error('Could not delete', errorText(e)),
            }),
        },
      ],
    );
  };

  return (
    <AppSheet
      open
      onClose={onClose}
      title={editing ? 'Edit expense' : 'New expense'}
      full
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2], gap: theme.spacing[2] }}>
          <Button
            title={editing ? 'Save changes' : 'Record expense'}
            onPress={submit}
            loading={create.isPending || update.isPending}
            disabled={busy}
          />
          {editing && canDelete ? (
            <Button
              title="Delete expense"
              variant="ghost"
              icon={<Trash2 size={16} color={theme.colors.dangerFg} />}
              onPress={confirmDelete}
              loading={remove.isPending}
            />
          ) : null}
        </View>
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          gap: theme.spacing[5],
          paddingBottom: theme.spacing[8],
        }}
      >
        <AmountInput label="Amount" valueCents={amountCents} onChangeCents={setAmountCents} insideSheet autoFocus />

        {cats.length > 0 ? (
          <SegmentedField
            label="Category"
            value={categoryId}
            options={[{ value: '', label: 'None' }, ...cats.map((c) => ({ value: c.id, label: c.name }))]}
            onChange={setCategoryId}
          />
        ) : null}

        {editing ? (
          <View style={{ gap: theme.spacing[2] }}>
            <AppText variant="label">Paid from</AppText>
            <AppText>{paidFromLabel(expense.paid_from, expense.owner_name)}</AppText>
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              Can&apos;t be changed — it decided which account the money left. Delete and re-record to
              move it.
            </AppText>
          </View>
        ) : (
          <PaidFromPicker
            value={paidFrom}
            onChange={setPaidFrom}
            ownerId={ownerId}
            onOwnerChange={setOwnerId}
            amountCents={amountCents}
            funding={funding}
          />
        )}

        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">Vendor (optional)</AppText>
          <AppSheet.TextInput
            value={vendor}
            onChangeText={setVendor}
            placeholder="e.g. Local mill"
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="Vendor (optional)"
            style={fieldStyle(theme)}
          />
          {suggestions.length > 0 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
              {suggestions.map((v) => (
                <Chip
                  key={v}
                  label={v}
                  onPress={() => setVendor(v)}
                  testID={`vendor-suggestion-${v}`}
                />
              ))}
            </View>
          ) : null}
        </View>

        <PaidAtField
          day={paidDay}
          onDayChange={setPaidDay}
          time={paidTime}
          onTimeChange={setPaidTime}
          error={timeBad}
        />

        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">Reference (optional)</AppText>
          <AppSheet.TextInput
            value={referenceNo}
            onChangeText={setReferenceNo}
            placeholder="Bill or receipt number"
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="Reference (optional)"
            style={fieldStyle(theme)}
          />
        </View>

        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">Notes (optional)</AppText>
          <AppSheet.TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="What was it for"
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="Notes (optional)"
            multiline
            style={fieldStyle(theme, { minHeight: 88, textAlignVertical: 'top' })}
          />
        </View>

        {editing ? (
          <View style={{ gap: theme.spacing[2] }}>
            <AppText variant="label">Stock link</AppText>
            {expense.linked_inventory_name ? (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
                  <Boxes size={14} color={theme.colors.textMuted} />
                  <AppText>{expense.linked_inventory_name}</AppText>
                </View>
                <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                  The link can&apos;t change, but editing the amount recomputes what that stock cost
                  per unit.
                </AppText>
              </>
            ) : (
              <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                Not a stock purchase. Delete and re-record to link one.
              </AppText>
            )}
          </View>
        ) : canReadInventory && invItems.length > 0 ? (
          <View style={{ gap: theme.spacing[2] }}>
            <AppText variant="label">Add to stock (optional)</AppText>
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              Bought stock? Pick the item and how many units and it goes into inventory too, so you
              don&apos;t log the same purchase twice.
            </AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
              <Chip label="None" selected={!invId} onPress={() => setInvId('')} testID="stock-none" />
              {invItems.map((i) => (
                <Chip
                  key={i.id}
                  label={i.name}
                  selected={invId === i.id}
                  onPress={() => setInvId(i.id)}
                  testID={`stock-${i.id}`}
                />
              ))}
            </View>
            {invId ? (
              <View style={{ gap: theme.spacing[2] }}>
                <AppText variant="label">
                  Units bought ({invItems.find((i) => i.id === invId)?.sale_unit ?? 'units'})
                </AppText>
                <AppSheet.TextInput
                  value={units}
                  onChangeText={setUnits}
                  keyboardType="decimal-pad"
                  placeholder="200"
                  placeholderTextColor={theme.colors.textFaint}
                  accessibilityLabel="Units bought"
                  style={fieldStyle(theme)}
                />
                <AppText variant="faint" style={{ fontSize: theme.text.sm, fontFamily: theme.fonts.mono }}>
                  {amountCents > 0 && Number(units) > 0
                    ? `unit cost = ${formatNPR(Math.round(amountCents / Number(units)))}`
                    : 'unit cost = amount ÷ units'}
                </AppText>
              </View>
            ) : null}
          </View>
        ) : null}
      </AppSheet.ScrollView>
    </AppSheet>
  );
}

/**
 * When the money actually left — a day stepper plus a plain HH:MM field.
 *
 * Deliberately not a calendar: back-dating an expense is almost always "it was
 * yesterday", and a date-picker dependency would cost more than the two taps
 * it saves. The stepper refuses to walk past today, since the server rejects a
 * future `paid_at` and a mistyped year would otherwise hide the row.
 */
function PaidAtField({
  day,
  onDayChange,
  time,
  onTimeChange,
  error,
}: {
  day: string;
  onDayChange: (d: string) => void;
  time: string;
  onTimeChange: (t: string) => void;
  error: boolean;
}) {
  const theme = useTheme();
  const today = todayStr();
  const atToday = day >= today;

  return (
    <View style={{ gap: theme.spacing[2] }}>
      <AppText variant="label">Paid at</AppText>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
        <Button
          title=""
          variant="secondary"
          accessibilityLabel="paid-at-previous-day"
          icon={<ChevronLeft size={16} color={theme.colors.text} />}
          onPress={() => onDayChange(shiftDay(day, -1))}
        />
        <AppText style={{ flex: 1, textAlign: 'center', fontFamily: theme.fonts.bodyMedium }}>
          {formatDayLabel(day, today)}
        </AppText>
        <Button
          title=""
          variant="secondary"
          accessibilityLabel="paid-at-next-day"
          disabled={atToday}
          icon={<ChevronRight size={16} color={atToday ? theme.colors.textFaint : theme.colors.text} />}
          onPress={() => onDayChange(shiftDay(day, 1))}
        />
        <AppSheet.TextInput
          value={time}
          onChangeText={onTimeChange}
          keyboardType="numbers-and-punctuation"
          placeholder="14:30"
          placeholderTextColor={theme.colors.textFaint}
          accessibilityLabel="Paid at time"
          style={fieldStyle(theme, {
            width: 82,
            textAlign: 'center',
            fontFamily: theme.fonts.mono,
            borderColor: error ? theme.colors.dangerFg : theme.colors.border,
          })}
        />
      </View>
      {error ? (
        <AppText style={{ color: theme.colors.dangerFg, fontSize: theme.text.sm }}>
          Use HH:MM, e.g. 14:30.
        </AppText>
      ) : null}
    </View>
  );
}

function fieldStyle(theme: Theme, extra?: object) {
  return {
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaces[2],
    borderRadius: theme.radii.md,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    fontFamily: theme.fonts.body,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...extra,
  };
}
