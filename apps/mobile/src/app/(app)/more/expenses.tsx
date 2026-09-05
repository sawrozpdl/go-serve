/**
 * Expenses — list, record, edit and delete (amount, category, where the money
 * came from, vendor, note). Owner-funded sources need an owner picker
 * (deferred), so mobile offers drawer + bank.
 *
 * Editing deliberately never sends `allocations` or the payment source: the
 * former would wipe a cost-centre split set on the dashboard, the latter is
 * immutable server-side. See `EditableExpenseFields` in api/expenses.ts.
 */
import { memo, useState } from 'react';
import { View, Pressable, RefreshControl, Alert } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Receipt, Trash2 } from 'lucide-react-native';
import type { Expense, ExpensePaidFrom } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { AppSheet } from '@/components/ui/AppSheet';
import { AmountInput } from '@/components/ui/AmountInput';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { StackHeader } from '@/components/ui/StackHeader';
import { SegmentedField } from '@/components/ui/Field';
import { useTheme, type Theme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import {
  useExpenses,
  useExpenseCategories,
  useCreateExpense,
  useUpdateExpense,
  useDeleteExpense,
} from '@/api/expenses';
import { formatNPR } from '@/lib/format';
import { toast } from '@/lib/toast';
import { errorText } from '@/lib/errorText';

const SOURCES: { value: ExpensePaidFrom; label: string }[] = [
  { value: 'drawer', label: 'Cash drawer' },
  { value: 'bank', label: 'Bank' },
];

/** The raw enum leaked into the list ("owner_cash"); say it in words. */
const PAID_FROM_LABEL: Record<string, string> = {
  drawer: 'Cash drawer',
  bank: 'Bank',
  owner: 'Owner paid',
  owner_cash: 'Owner-held cash',
};

export default function ExpensesScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const expenses = useExpenses();

  const [form, setForm] = useState(false);
  /** The row being edited, or null while adding a new one. */
  const [editing, setEditing] = useState<Expense | null>(null);

  const canRead = can(me.data, 'expense:read');
  const canCreate = can(me.data, 'expense:create');
  const canUpdate = can(me.data, 'expense:update');
  const canDelete = can(me.data, 'expense:delete');
  if (me.data && !canRead) return <Redirect href="/more" />;

  const rows = expenses.data ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader
        title="Expenses"
        right={
          canCreate ? (
            <Pressable onPress={() => setForm(true)} hitSlop={10} accessibilityLabel="add-expense">
              <Plus size={24} color={theme.colors.primary} />
            </Pressable>
          ) : undefined
        }
      />
      {expenses.isError && rows.length === 0 ? (
        <View style={{ paddingHorizontal: theme.spacing[5] }}>
          <ErrorState detail={errorText(expenses.error)} onRetry={() => void expenses.refetch()} />
        </View>
      ) : expenses.isLoading ? (
        <View style={{ gap: theme.spacing[3], paddingTop: theme.spacing[3], paddingHorizontal: theme.spacing[5] }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={64} radius={theme.radii.lg} />
          ))}
        </View>
      ) : rows.length === 0 ? (
        <View style={{ paddingHorizontal: theme.spacing[5] }}>
          <EmptyState icon={<Receipt size={28} color={theme.colors.textFaint} />} title="No expenses recorded yet." />
        </View>
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(e) => e.id}
          contentContainerStyle={{
            paddingTop: theme.spacing[3],
            paddingHorizontal: theme.spacing[5],
            paddingBottom: insets.bottom + theme.spacing[10],
          }}
          refreshControl={<RefreshControl refreshing={expenses.isRefetching} onRefresh={() => void expenses.refetch()} tintColor={theme.colors.primary} />}
          renderItem={({ item: e }) => (
            <ExpenseRow
              expense={e}
              onEdit={canUpdate ? () => { setEditing(e); setForm(true); } : undefined}
            />
          )}
        />
      )}

      {form ? (
        <ExpenseForm
          expense={editing}
          canDelete={canDelete}
          onClose={() => {
            setForm(false);
            setEditing(null);
          }}
        />
      ) : null}
    </View>
  );
}

/** One expense line. Memoized so scrolling only renders newly-visible rows. */
const ExpenseRow = memo(function ExpenseRow({
  expense: e,
  onEdit,
}: {
  expense: Expense;
  /** Absent when the member may not edit — the row then isn't pressable. */
  onEdit?: () => void;
}) {
  const theme = useTheme();
  return (
    <Card
      level={2}
      elevated={false}
      onPress={onEdit}
      accessibilityLabel={`expense-${e.vendor || e.expense_category_name || 'row'}`}
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: theme.spacing[3],
        marginBottom: theme.spacing[3],
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <AppText style={{ fontFamily: theme.fonts.bodyMedium }} numberOfLines={1}>
          {e.vendor || e.expense_category_name || 'Expense'}
        </AppText>
        <AppText variant="faint" style={{ fontSize: theme.text.sm }} numberOfLines={1}>
          {e.expense_category_name ? `${e.expense_category_name} · ` : ''}
          {PAID_FROM_LABEL[e.paid_from] ?? e.paid_from} · {new Date(e.paid_at).toLocaleDateString()}
        </AppText>
        {e.notes ? (
          <AppText variant="faint" style={{ fontSize: theme.text.sm }} numberOfLines={1}>
            {e.notes}
          </AppText>
        ) : null}
      </View>
      <MonoText weight="medium" numberOfLines={1} style={{ flexShrink: 0 }}>
        {formatNPR(e.amount_cents)}
      </MonoText>
    </Card>
  );
});

function ExpenseForm({
  expense,
  canDelete,
  onClose,
}: {
  /** null = recording a new expense; otherwise the row being edited. */
  expense: Expense | null;
  canDelete: boolean;
  onClose: () => void;
}) {
  const theme = useTheme();
  const create = useCreateExpense();
  const update = useUpdateExpense();
  const remove = useDeleteExpense();
  const categories = useExpenseCategories();
  const editing = !!expense;

  const [amountCents, setAmountCents] = useState(expense?.amount_cents ?? 0);
  const [categoryId, setCategoryId] = useState<string>(expense?.expense_category_id ?? '');
  const [paidFrom, setPaidFrom] = useState<ExpensePaidFrom>(expense?.paid_from ?? 'drawer');
  const [vendor, setVendor] = useState(expense?.vendor ?? '');
  const [notes, setNotes] = useState(expense?.notes ?? '');

  const cats = categories.data ?? [];
  const busy = create.isPending || update.isPending || remove.isPending;

  const submit = () => {
    if (amountCents <= 0) return toast.error('Enter an amount');

    if (editing) {
      // Only the mutable fields. `paid_from` is immutable server-side (it would
      // rewrite ledgers) and `allocations` is deliberately never sent, so a
      // cost-centre split set on the dashboard survives a phone edit.
      update.mutate(
        {
          id: expense.id,
          patch: {
            amount_cents: amountCents,
            expense_category_id: categoryId || null,
            clear_category: !categoryId,
            vendor: vendor.trim(),
            notes: notes.trim(),
          },
        },
        {
          onSuccess: () => { toast.success('Expense updated'); onClose(); },
          onError: (e) => toast.error('Could not save', errorText(e)),
        },
      );
      return;
    }

    create.mutate(
      {
        amount_cents: amountCents,
        expense_category_id: categoryId || null,
        paid_from: paidFrom,
        vendor: vendor.trim(),
        notes: notes.trim(),
      },
      { onSuccess: () => { toast.success('Expense recorded'); onClose(); }, onError: (e) => toast.error('Could not save', errorText(e)) },
    );
  };

  const confirmDelete = () => {
    if (!expense) return;
    Alert.alert(
      'Delete this expense?',
      paidFrom === 'drawer'
        ? 'The cash it took out of the drawer is given back, and the drawer total is recalculated.'
        : 'It stops counting against the cafe, and any balance it moved is given back.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            remove.mutate(expense.id, {
              onSuccess: () => { toast.success('Expense deleted'); onClose(); },
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
      <AppSheet.ScrollView contentContainerStyle={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[8] }}>
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
          /* The money source can't change: it decided which ledger the expense
             posted to. Shown, not editable — delete and re-create instead. */
          <View style={{ gap: theme.spacing[2] }}>
            <AppText variant="label">Paid from</AppText>
            <AppText>{PAID_FROM_LABEL[paidFrom] ?? paidFrom}</AppText>
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              Can&apos;t be changed — it decided which account the money left. Delete
              and re-record to move it.
            </AppText>
          </View>
        ) : (
          <SegmentedField label="Paid from" value={paidFrom} options={SOURCES} onChange={setPaidFrom} />
        )}
        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">Vendor (optional)</AppText>
          <AppSheet.TextInput
            value={vendor}
            onChangeText={setVendor}
            placeholder="e.g. Dairy supplier"
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="Vendor (optional)"
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
      </AppSheet.ScrollView>
    </AppSheet>
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
