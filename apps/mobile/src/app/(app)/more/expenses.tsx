/**
 * Expenses (M8) — recent list + quick add (amount, category, where the money
 * came from, vendor, note). Owner-funded sources need an owner picker (deferred),
 * so mobile offers drawer + bank; the full ledger lives on web.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, RefreshControl } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus } from 'lucide-react-native';
import type { ExpensePaidFrom } from '@cafe-mgmt/api-types';
import { AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Sheet } from '@/components/ui/Sheet';
import { StackHeader } from '@/components/ui/StackHeader';
import { SegmentedField } from '@/components/ui/Field';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useExpenses, useExpenseCategories, useCreateExpense } from '@/api/expenses';
import { parsePriceToCents } from '@/catalog/money';
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
        {expenses.isLoading ? (
          <AppText variant="faint">Loading…</AppText>
        ) : rows.length === 0 ? (
          <AppText variant="muted">No expenses recorded yet.</AppText>
        ) : (
          rows.map((e) => (
            <View
              key={e.id}
              style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: theme.colors.card, borderRadius: theme.radii.md, borderWidth: 1, borderColor: theme.colors.border, padding: theme.spacing[4] }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <AppText style={{ fontFamily: theme.fonts.bodyMedium }}>{e.vendor || e.expense_category_name || 'Expense'}</AppText>
                <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                  {e.expense_category_name ? `${e.expense_category_name} · ` : ''}
                  {e.paid_from} · {new Date(e.paid_at).toLocaleDateString()}
                </AppText>
              </View>
              <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{formatNPR(e.amount_cents)}</AppText>
            </View>
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
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [paidFrom, setPaidFrom] = useState<ExpensePaidFrom>('drawer');
  const [vendor, setVendor] = useState('');
  const [notes, setNotes] = useState('');

  const cats = categories.data ?? [];

  const submit = () => {
    const cents = parsePriceToCents(amount);
    if (cents <= 0) return toast.error('Enter an amount');
    create.mutate(
      {
        amount_cents: cents,
        expense_category_id: categoryId || null,
        paid_from: paidFrom,
        vendor: vendor.trim(),
        notes: notes.trim(),
      },
      { onSuccess: () => { toast.success('Expense recorded'); onClose(); }, onError: (e) => toast.error('Could not save', (e as Error).message) },
    );
  };

  return (
    <Sheet open onClose={onClose} title="New expense" full>
      <ScrollView contentContainerStyle={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[8] }}>
        <TextField label="Amount" value={amount} onChangeText={setAmount} placeholder="0" keyboardType="decimal-pad" autoFocus />
        {cats.length > 0 ? (
          <SegmentedField
            label="Category"
            value={categoryId}
            options={[{ value: '', label: 'None' }, ...cats.map((c) => ({ value: c.id, label: c.name }))]}
            onChange={setCategoryId}
          />
        ) : null}
        <SegmentedField label="Paid from" value={paidFrom} options={SOURCES} onChange={setPaidFrom} />
        <TextField label="Vendor (optional)" value={vendor} onChangeText={setVendor} placeholder="e.g. Dairy supplier" />
        <TextField label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="What was it for" multiline />
        <Button title="Record expense" onPress={submit} loading={create.isPending} />
      </ScrollView>
    </Sheet>
  );
}
