/**
 * Where the money for an expense came from — the heart of the 0014 expense
 * flow, and the half of it mobile never had.
 *
 * The four sources are not interchangeable labels; each posts to a different
 * ledger:
 *
 *   drawer     — cash leaves the till during the open shift
 *   bank       — debits the cafe's bank balance
 *   owner      — the owner paid from their OWN pocket, so the cafe now owes
 *                them: this creates a loan
 *   owner_cash — the owner spent cafe cash they had already taken from the
 *                drawer: this draws that holding down and is NOT a new debt
 *
 * Picking the wrong one of the last two either invents a debt or hides one, so
 * each carries the explanation web shows rather than leaving the operator to
 * infer it from a four-word label.
 *
 * The source is immutable once recorded, which is why this is create-only —
 * the edit form prints it read-only instead.
 */
import { View, Pressable } from 'react-native';
import { Banknote, Wallet, Crown, HandCoins, AlertTriangle, Info, type LucideIcon } from 'lucide-react-native';
import type { ExpensePaidFrom } from '@cafe-mgmt/api-types';
import type { ReactNode } from 'react';
import { AppText } from '@/components/ui/Text';
import { Chip } from '@/components/ui/Chip';
import { useTheme, hexToRgba } from '@/theme';
import { formatNPR } from '@/lib/format';
import type { useExpenseFunding } from '@/expenses/useExpenseFunding';

export type Funding = ReturnType<typeof useExpenseFunding>;

export function PaidFromPicker({
  value,
  onChange,
  ownerId,
  onOwnerChange,
  amountCents,
  funding,
}: {
  value: ExpensePaidFrom;
  onChange: (v: ExpensePaidFrom) => void;
  ownerId: string;
  onOwnerChange: (id: string) => void;
  amountCents: number;
  funding: Funding;
}) {
  const theme = useTheme();
  const { drawerBlocked, bankCents, knowsBank, owners, showOwnerSources, heldBy, knowsHoldings } = funding;

  const heldCents = heldBy(ownerId);
  const ownerName = owners.find((o) => o.id === ownerId)?.display_name ?? 'the owner';

  return (
    <View style={{ gap: theme.spacing[3] }}>
      <AppText variant="label">Paid from</AppText>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
        <SourceTile
          active={value === 'drawer'}
          disabled={drawerBlocked}
          icon={Banknote}
          label="Cash drawer"
          sub={drawerBlocked ? 'no shift open' : 'cash from the till'}
          onPress={() => onChange('drawer')}
        />
        <SourceTile
          active={value === 'bank'}
          icon={Wallet}
          label="Bank"
          sub={knowsBank ? `available ${formatNPR(bankCents)}` : 'cafe bank account'}
          onPress={() => onChange('bank')}
        />
        {showOwnerSources ? (
          <>
            <SourceTile
              active={value === 'owner'}
              icon={Crown}
              label="Owner paid"
              sub="own pocket → a loan"
              onPress={() => onChange('owner')}
            />
            <SourceTile
              active={value === 'owner_cash'}
              icon={HandCoins}
              label="Owner's cafe cash"
              sub="cash they already hold"
              onPress={() => onChange('owner_cash')}
            />
          </>
        ) : null}
      </View>

      {value === 'drawer' ? (
        <Hint>
          Cash leaves the till during this shift. Closing the shift reconciles it for you.
        </Hint>
      ) : null}

      {value === 'bank' && knowsBank ? (
        amountCents > bankCents ? (
          <Hint tone="danger" icon={<AlertTriangle size={13} color={theme.colors.dangerFg} />}>
            That is more than the bank holds ({formatNPR(bankCents)}). Record the deposit first.
          </Hint>
        ) : amountCents > 0 ? (
          <Hint>
            Bank: {formatNPR(bankCents)} → {formatNPR(bankCents - amountCents)}
          </Hint>
        ) : (
          <Hint>Debits the cafe&apos;s bank balance.</Hint>
        )
      ) : null}

      {value === 'owner' || value === 'owner_cash' ? (
        <View style={{ gap: theme.spacing[3] }}>
          <Note>
            {value === 'owner' ? (
              <>
                Use this only when the owner paid out of their <Strong>own pocket</Strong> — the cafe
                will owe them back. If they spent cafe cash they had already taken from the drawer,
                pick <Strong>Owner&apos;s cafe cash</Strong> instead, so it draws that down rather
                than creating a new debt.
              </>
            ) : (
              <>
                The owner spent <Strong>cafe cash</Strong> they were already holding. This draws down
                what they hold — it is <Strong>not</Strong> a new debt.
              </>
            )}
          </Note>

          <View style={{ gap: theme.spacing[2] }}>
            <AppText variant="label">
              {value === 'owner' ? 'Which owner advanced this?' : 'Which owner spent it?'}
            </AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
              {owners.map((o) => (
                <Chip
                  key={o.id}
                  label={o.display_name}
                  selected={ownerId === o.id}
                  onPress={() => onOwnerChange(o.id)}
                  testID={`expense-owner-${o.id}`}
                />
              ))}
            </View>
          </View>

          {value === 'owner' && amountCents > 0 && ownerId ? (
            <Hint tone="warn">
              Creates a {formatNPR(amountCents)} loan from {ownerName}, repayable from the dashboard.
            </Hint>
          ) : null}

          {value === 'owner_cash' && ownerId && knowsHoldings ? (
            amountCents > heldCents ? (
              <Hint tone="danger" icon={<AlertTriangle size={13} color={theme.colors.dangerFg} />}>
                {ownerName} is only holding {formatNPR(heldCents)} of cafe cash.
              </Hint>
            ) : (
              <Hint tone="warn">
                Holding {formatNPR(heldCents)}
                {amountCents > 0 ? ` → ${formatNPR(heldCents - amountCents)}` : ''}
              </Hint>
            )
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function SourceTile({
  active,
  disabled,
  icon: Icon,
  label,
  sub,
  onPress,
}: {
  active: boolean;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  sub: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const fg = disabled ? theme.colors.textFaint : active ? theme.colors.primary : theme.colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled: !!disabled }}
      style={{
        flexGrow: 1,
        flexBasis: '46%',
        gap: 2,
        paddingHorizontal: theme.spacing[3],
        paddingVertical: theme.spacing[3],
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: active ? theme.colors.primary : theme.colors.border,
        backgroundColor: active ? theme.colors.primaryTint : 'transparent',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
        <Icon size={16} color={fg} />
        <AppText style={{ color: fg, fontFamily: theme.fonts.bodyMedium, fontSize: theme.text.sm }}>
          {label}
        </AppText>
      </View>
      <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
        {sub}
      </AppText>
    </Pressable>
  );
}

function Hint({
  children,
  tone = 'muted',
  icon,
}: {
  children: ReactNode;
  tone?: 'muted' | 'warn' | 'danger';
  icon?: ReactNode;
}) {
  const theme = useTheme();
  const color =
    tone === 'danger'
      ? theme.colors.dangerFg
      : tone === 'warn'
        ? theme.colors.stamp.warn.fg
        : theme.colors.textFaint;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing[2] }}>
      {icon}
      <AppText style={{ flex: 1, color, fontSize: theme.text.sm, fontFamily: theme.fonts.mono }}>
        {children}
      </AppText>
    </View>
  );
}

/** The boxed explanation for the two owner sources — the only place in the
 *  form where getting it wrong misstates what the cafe owes. */
function Note({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: theme.spacing[2],
        padding: theme.spacing[3],
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: hexToRgba(theme.colors.stamp.warn.fg, 0.22),
        backgroundColor: hexToRgba(theme.colors.stamp.warn.fg, 0.08),
      }}
    >
      <Info size={14} color={theme.colors.stamp.warn.fg} />
      <AppText style={{ flex: 1, fontSize: theme.text.sm, lineHeight: 20 }}>{children}</AppText>
    </View>
  );
}

function Strong({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{children}</AppText>;
}
