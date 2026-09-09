/**
 * Expenses — the day's spending, filtered, with the full record / correct /
 * delete cycle and its categories managed in place.
 *
 * The list opens on today rather than all-time, matching the dashboard: the
 * question an operator has on a phone is "what did we spend today", and an
 * undifferentiated all-time list answers it slowest of all. Everything past
 * that — a different day, a wider window, a category, a payment source, a text
 * search — is one tap away and reported back as a removable chip, so the list
 * never lies about what it is showing.
 */
import { memo, useEffect, useState } from 'react';
import { View, Pressable, TextInput, RefreshControl } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Receipt, Tag, ChevronLeft, ChevronRight, SlidersHorizontal, X, Boxes } from 'lucide-react-native';
import type { Expense } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { StackHeader } from '@/components/ui/StackHeader';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can, hasFeature } from '@/auth/permissions';
import { useExpenses, useExpenseCategories } from '@/api/expenses';
import { formatNPR } from '@/lib/format';
import { errorText } from '@/lib/errorText';
import { todayStr, shiftDay } from '@/lib/dates';
import {
  initialFilters,
  toQuery,
  rangeLabel,
  activeFilterCount,
  summarize,
  paidFromLabel,
  type ExpenseFilterState,
} from '@/expenses/filters';
import { ExpenseFiltersSheet } from '@/components/expenses/ExpenseFiltersSheet';
import { ExpenseCategoriesSheet } from '@/components/expenses/ExpenseCategoriesSheet';
import { ExpenseForm } from '@/components/expenses/ExpenseForm';

export default function ExpensesScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const today = todayStr();

  const [filters, setFilters] = useState<ExpenseFilterState>(() => initialFilters(today));
  // Typing hits the server on a pause, everything else immediately — a keypress
  // per request would spend a service's worth of round-trips on one word.
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search })), 300);
    return () => clearTimeout(t);
  }, [search]);

  const expenses = useExpenses(toQuery(filters));
  const categories = useExpenseCategories();

  const [form, setForm] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [catsOpen, setCatsOpen] = useState(false);

  const canRead = can(me.data, 'expense:read');
  const canCreate = can(me.data, 'expense:create');
  const canUpdate = can(me.data, 'expense:update');
  const canDeleteCat = can(me.data, 'expense:delete');
  const showOwnerSources = can(me.data, 'finance:read') && hasFeature(me.data, 'owner_finance');
  if (me.data && !canRead) return <Redirect href="/more" />;

  const rows = expenses.data?.expenses ?? [];
  const { totalCents } = summarize(rows);
  // The server pages at 200 and reports how many matched. When a wide filter
  // matches more than came back, the money on screen is a partial sum — say so
  // rather than printing a figure that quietly understates the spend.
  const count = expenses.data?.total ?? rows.length;
  const truncated = count > rows.length;
  const filterCount = activeFilterCount(filters, today);
  const cats = categories.data ?? [];
  const clear = () => {
    setSearch('');
    setFilters(initialFilters(today));
  };

  const stepDay = (delta: number) =>
    setFilters((f) => ({ ...f, range: 'day', day: shiftDay(f.day, delta) }));

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader
        title="Expenses"
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[4] }}>
            {canCreate ? (
              <Pressable onPress={() => setCatsOpen(true)} hitSlop={10} accessibilityLabel="manage-categories">
                <Tag size={22} color={theme.colors.textMuted} />
              </Pressable>
            ) : null}
            {canCreate ? (
              <Pressable onPress={() => setForm(true)} hitSlop={10} accessibilityLabel="add-expense">
                <Plus size={24} color={theme.colors.primary} />
              </Pressable>
            ) : null}
          </View>
        }
      />

      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[3], paddingBottom: theme.spacing[3] }}>
        {/* Period + what it adds up to, so the total on screen always names the
            window it belongs to. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
          {filters.range === 'day' ? (
            <>
              <Pressable
                onPress={() => stepDay(-1)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="previous-day"
              >
                <ChevronLeft size={20} color={theme.colors.textMuted} />
              </Pressable>
              <Pressable
                onPress={() => setFilters((f) => ({ ...f, day: today }))}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="jump-to-today"
              >
                <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{rangeLabel(filters, today)}</AppText>
              </Pressable>
              <Pressable
                onPress={() => stepDay(1)}
                disabled={filters.day >= today}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="next-day"
                accessibilityState={{ disabled: filters.day >= today }}
              >
                <ChevronRight
                  size={20}
                  color={filters.day >= today ? theme.colors.textFaint : theme.colors.textMuted}
                />
              </Pressable>
            </>
          ) : (
            <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{rangeLabel(filters, today)}</AppText>
          )}
          <View style={{ flex: 1 }} />
          <MonoText muted size="sm">
            {count} {count === 1 ? 'expense' : 'expenses'}
          </MonoText>
          <MonoText weight="medium">{formatNPR(totalCents)}</MonoText>
        </View>

        {truncated ? (
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            Showing the latest {rows.length}. Narrow the period for an exact total.
          </AppText>
        ) : null}

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Vendor, notes, reference…"
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="search-expenses"
            returnKeyType="search"
            style={{
              flex: 1,
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
          <Chip
            label="Filters"
            icon={<SlidersHorizontal size={14} color={theme.colors.textMuted} />}
            count={filterCount > 0 ? filterCount : undefined}
            selected={filterCount > 0}
            onPress={() => setFiltersOpen(true)}
            testID="open-filters"
          />
        </View>

        {filterCount > 0 ? (
          <Pressable
            onPress={clear}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="clear-filters"
            style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[1] }}
          >
            <X size={13} color={theme.colors.textFaint} />
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              Clear filters
            </AppText>
          </Pressable>
        ) : null}
      </View>

      {expenses.isError && rows.length === 0 ? (
        <View style={{ paddingHorizontal: theme.spacing[5] }}>
          <ErrorState detail={errorText(expenses.error)} onRetry={() => void expenses.refetch()} />
        </View>
      ) : expenses.isLoading ? (
        <View style={{ gap: theme.spacing[3], paddingHorizontal: theme.spacing[5] }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={64} radius={theme.radii.lg} />
          ))}
        </View>
      ) : rows.length === 0 ? (
        <View style={{ paddingHorizontal: theme.spacing[5] }}>
          <EmptyState
            icon={<Receipt size={28} color={theme.colors.textFaint} />}
            title={filterCount > 0 ? 'Nothing matches these filters.' : 'Nothing spent yet.'}
            hint={
              filterCount > 0
                ? 'Widen the period, or clear the filters to see everything.'
                : `No expenses recorded for ${rangeLabel(filters, today).toLowerCase()}.`
            }
            action={filterCount > 0 ? { label: 'Clear filters', onPress: clear } : undefined}
          />
        </View>
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(e) => e.id}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing[5],
            paddingBottom: insets.bottom + theme.spacing[10],
          }}
          refreshControl={
            <RefreshControl
              refreshing={expenses.isRefetching}
              onRefresh={() => void expenses.refetch()}
              tintColor={theme.colors.primary}
            />
          }
          renderItem={({ item: e }) => (
            <ExpenseRow
              expense={e}
              onEdit={
                canUpdate
                  ? () => {
                      setEditing(e);
                      setForm(true);
                    }
                  : undefined
              }
            />
          )}
        />
      )}

      {form ? (
        <ExpenseForm
          expense={editing}
          onClose={() => {
            setForm(false);
            setEditing(null);
          }}
        />
      ) : null}

      <ExpenseFiltersSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        filters={filters}
        onChange={setFilters}
        onClear={clear}
        categories={cats}
        showOwnerSources={showOwnerSources}
      />

      <ExpenseCategoriesSheet
        open={catsOpen}
        onClose={() => setCatsOpen(false)}
        canEdit={canCreate}
        canDelete={canDeleteCat}
      />
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
          {paidFromLabel(e.paid_from, e.owner_name)} · {new Date(e.paid_at).toLocaleDateString()}
        </AppText>
        {e.linked_inventory_name ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[1] }}>
            <Boxes size={12} color={theme.colors.textFaint} />
            <AppText variant="faint" style={{ fontSize: theme.text.sm }} numberOfLines={1}>
              {e.linked_inventory_name}
            </AppText>
          </View>
        ) : null}
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
