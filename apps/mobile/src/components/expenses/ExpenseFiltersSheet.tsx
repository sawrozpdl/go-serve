/**
 * The expense list's range / category / source filters.
 *
 * They live in a sheet rather than a bar because a phone that showed all three
 * inline would have more chrome than list. The two the operator reaches for
 * most — the day and the search text — stay on the screen itself; these are
 * the ones opened deliberately.
 *
 * Edits apply immediately to the parent's state, so the sheet has no Apply
 * button: closing it is the whole interaction. `Clear` resets to today.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { ExpenseCategory, ExpensePaidFrom } from '@cafe-mgmt/api-types';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { useTheme } from '@/theme';
import type { ExpenseFilterState, ExpenseRange } from '@/expenses/filters';

const RANGES: { value: ExpenseRange; label: string }[] = [
  { value: 'day', label: 'One day' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All time' },
];

const SOURCES: { value: '' | ExpensePaidFrom; label: string }[] = [
  { value: '', label: 'Any source' },
  { value: 'drawer', label: 'Cash drawer' },
  { value: 'bank', label: 'Bank' },
  { value: 'owner', label: 'Owner paid' },
  { value: 'owner_cash', label: "Owner's cafe cash" },
];

export function ExpenseFiltersSheet({
  open,
  onClose,
  filters,
  onChange,
  onClear,
  categories,
  /** Owner-funded sources are hidden when the plan or the role can't reach
   *  them — filtering by a source this cafe can never record is dead UI. */
  showOwnerSources,
}: {
  open: boolean;
  onClose: () => void;
  filters: ExpenseFilterState;
  onChange: (next: ExpenseFilterState) => void;
  onClear: () => void;
  categories: ExpenseCategory[];
  showOwnerSources: boolean;
}) {
  const theme = useTheme();
  const sources = showOwnerSources ? SOURCES : SOURCES.filter((s) => !s.value.startsWith('owner'));

  return (
    <AppSheet
      open={open}
      onClose={onClose}
      title="Filters"
      size="medium"
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2], gap: theme.spacing[2] }}>
          <Button title="Done" onPress={onClose} />
          <Button title="Clear filters" variant="ghost" onPress={onClear} />
        </View>
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[4],
          gap: theme.spacing[5],
        }}
      >
        <Group label="Period">
          {RANGES.map((r) => (
            <Chip
              key={r.value}
              label={r.label}
              selected={filters.range === r.value}
              onPress={() => onChange({ ...filters, range: r.value })}
              testID={`expense-range-${r.value}`}
            />
          ))}
        </Group>

        <Group label="Category">
          <Chip
            label="All categories"
            selected={!filters.categoryId}
            onPress={() => onChange({ ...filters, categoryId: '' })}
            testID="expense-cat-any"
          />
          {categories.map((c) => (
            <Chip
              key={c.id}
              label={c.name}
              selected={filters.categoryId === c.id}
              onPress={() => onChange({ ...filters, categoryId: c.id })}
            />
          ))}
        </Group>

        <Group label="Paid from">
          {sources.map((s) => (
            <Chip
              key={s.value || 'any'}
              label={s.label}
              selected={filters.paidFrom === s.value}
              onPress={() => onChange({ ...filters, paidFrom: s.value })}
              testID={`expense-source-${s.value || 'any'}`}
            />
          ))}
        </Group>
      </AppSheet.ScrollView>
    </AppSheet>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing[2] }}>
      <AppText variant="label">{label}</AppText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>{children}</View>
    </View>
  );
}
