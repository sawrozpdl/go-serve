/**
 * An item's stock ledger.
 *
 * `useInventoryMovements` has existed since M7 with nothing wired to it, so
 * the phone could show a count of minus three and offer no way to find out
 * why. Every row carries a running balance walked back from today's on-hand
 * figure, because the delta alone ("−5") never answers "when did this go
 * wrong" — the balance column does.
 */
import { View } from 'react-native';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Stamp } from '@/components/ui/Stamp';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import type { InventoryItem } from '@cafe-mgmt/api-types';
import { useTheme } from '@/theme';
import { useInventoryMovements } from '@/api/inventory';
import { formatNPR } from '@/lib/format';
import { errorText } from '@/lib/errorText';
import { runningBalances, movementTone, movementLabel, formatDelta, trimQty } from '@/inventory/stock';

export function MovementsSheet({ item, onClose }: { item: InventoryItem; onClose: () => void }) {
  const theme = useTheme();
  const movements = useInventoryMovements(item.id);
  const rows = runningBalances(movements.data?.movements ?? [], item.qty_on_hand_units);
  const total = movements.data?.total ?? rows.length;

  return (
    <AppSheet
      open
      onClose={onClose}
      title={`Movements · ${item.name}`}
      size="full"
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] }}>
          <Button title="Done" variant="secondary" onPress={onClose} />
        </View>
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[6],
          gap: theme.spacing[3],
        }}
      >
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          On hand{' '}
          <MonoText size="sm" muted>
            {trimQty(item.qty_on_hand_units)}
          </MonoText>{' '}
          {item.sale_unit} · {total} movement{total === 1 ? '' : 's'}
        </AppText>

        {movements.isLoading ? (
          <View style={{ gap: theme.spacing[2] }}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={52} radius={theme.radii.md} />
            ))}
          </View>
        ) : movements.isError && rows.length === 0 ? (
          <ErrorState detail={errorText(movements.error)} onRetry={() => void movements.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing has moved yet."
            hint="Purchases, sales and corrections all land here."
          />
        ) : (
          rows.map(({ movement: m, balanceAfter }) => (
            <View
              key={m.id}
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: theme.spacing[3],
                paddingVertical: theme.spacing[2],
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.border,
              }}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Stamp tone={movementTone(m.reason)} label={movementLabel(m.reason)} size="sm" />
                <MonoText size="2xs" muted numberOfLines={1}>
                  {new Date(m.at).toLocaleString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {m.by_user_name ? ` · ${m.by_user_name}` : ''}
                </MonoText>
                {m.notes ? (
                  <AppText variant="faint" style={{ fontSize: theme.text.sm }} numberOfLines={2}>
                    {m.notes}
                  </AppText>
                ) : null}
                {m.unit_cost_cents ? (
                  <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                    {formatNPR(m.unit_cost_cents)} per {item.sale_unit}
                  </AppText>
                ) : null}
              </View>
              <View style={{ alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
                <MonoText
                  size="sm"
                  weight="medium"
                  style={{
                    color: m.delta_units.startsWith('-')
                      ? theme.colors.dangerFg
                      : theme.colors.successFg,
                  }}
                >
                  {formatDelta(m.delta_units)}
                </MonoText>
                {/* The delta alone never answers "when did this go wrong". */}
                <MonoText
                  size="2xs"
                  muted
                  style={balanceAfter < 0 ? { color: theme.colors.dangerFg } : undefined}
                >
                  {balanceAfter}
                </MonoText>
              </View>
            </View>
          ))
        )}

        {total > rows.length ? (
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            Showing the latest {rows.length} of {total}. The dashboard has the full ledger.
          </AppText>
        ) : null}
      </AppSheet.ScrollView>
    </AppSheet>
  );
}
