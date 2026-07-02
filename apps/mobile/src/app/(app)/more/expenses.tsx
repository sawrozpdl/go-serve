/**
 * Expenses (M8) — recent list + quick add (amount, category, where the money
 * came from, vendor, note). Owner-funded sources need an owner picker (deferred),
 * so mobile offers drawer + bank; the full ledger lives on web.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, RefreshControl } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Receipt } from 'lucide-react-native';
import type { ExpensePaidFrom } from '@cafe-mgmt/api-types';
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
import { useExpenses, useExpenseCategories, useCreateExpense } from '@/api/expenses';
import { formatNPR } from '@/lib/format';
import { toast } from '@/lib/toast';

const SOURCES: { value: ExpensePaidFrom; label: string }[] = [
  { value: 'drawer', label: 'Cash drawer' },
  { value: 'bank', label: 'Bank' },
];

export default function ExpensesScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const expenses = useExpenses();

  const [form, setForm] = useState(false);

  const canRead = can(me.data, 'expense:read');
  const canCreate = can(me.data, 'expense:create');
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
      <ScrollView
        contentContainerStyle={{
          paddingTop: theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[3],
        }}
        refreshControl={<RefreshControl refreshing={expenses.isRefetching} onRefresh={() => void expenses.refetch()} tintColor={theme.colors.primary} />}
      >
        {expenses.isError && rows.length === 0 ? (
          <ErrorState detail={String(expenses.error)} onRetry={() => void expenses.refetch()} />
        ) : expenses.isLoading ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} height={64} radius={theme.radii.lg} />)
        ) : rows.length === 0 ? (
          <EmptyState icon={<Receipt size={28} color={theme.colors.textFaint} />} title="No expenses recorded yet." />
        ) : (
          rows.map((e) => (
            <Card
              key={e.id}
              level={2}
              elevated={false}
              style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing[3] }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <AppText style={{ fontFamily: theme.fonts.bodyMedium }} numberOfLines={1}>
                  {e.vendor || e.expense_category_name || 'Expense'}
                </AppText>
                <AppText variant="faint" style={{ fontSize: theme.text.sm }} numberOfLines={1}>
                  {e.expense_category_name ? `${e.expense_category_name} · ` : ''}
                  {e.paid_from} · {new Date(e.paid_at).toLocaleDateString()}
                </AppText>
              </View>
              <MonoText weight="medium">{formatNPR(e.amount_cents)}</MonoText>
            </Card>
          ))
        )}
      </ScrollView>

      {form ? <ExpenseForm onClose={() => setForm(false)} /> : null}
    </View>
  );
}

function ExpenseForm({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const create = useCreateExpense();
  const categories = useExpenseCategories();
  const [amountCents, setAmountCents] = useState(0);
  const [categoryId, setCategoryId] = useState<string>('');
  const [paidFrom, setPaidFrom] = useState<ExpensePaidFrom>('drawer');
  const [vendor, setVendor] = useState('');
  const [notes, setNotes] = useState('');

  const cats = categories.data ?? [];

  const submit = () => {
    if (amountCents <= 0) return toast.error('Enter an amount');
    create.mutate(
      {
        amount_cents: amountCents,
        expense_category_id: categoryId || null,
        paid_from: paidFrom,
        vendor: vendor.trim(),
        notes: notes.trim(),
      },
      { onSuccess: () => { toast.success('Expense recorded'); onClose(); }, onError: (e) => toast.error('Could not save', (e as Error).message) },
    );
  };

  return (
    <AppSheet
      open
      onClose={onClose}
      title="New expense"
      full
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] }}>
          <Button title="Record expense" onPress={submit} loading={create.isPending} />
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
        <SegmentedField label="Paid from" value={paidFrom} options={SOURCES} onChange={setPaidFrom} />
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
