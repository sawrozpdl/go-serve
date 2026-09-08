/**
 * Discount a tab from the ticket itself.
 *
 * The cafe chooses where discounts live: `preferences.combinedSettle` puts them
 * inside the settle sheet, and with it off they belong here, on the ticket,
 * before payment is taken at all. Mobile only ever had the settle path, so a
 * cafe with the preference off had no way to discount from a phone.
 *
 * Applying is a money write — blocked offline like every other one, since the
 * offline queue deliberately carries order edits only.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { promotionLabel, type OrderAdjustment } from '@cafe-mgmt/api-types';
import { Trash2 } from 'lucide-react-native';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { ListRow } from '@/components/ui/ListRow';
import { AmountInput } from '@/components/ui/AmountInput';
import { useTheme } from '@/theme';
import { formatNPR } from '@/lib/format';
import { toast } from '@/lib/toast';
import { errorText } from '@/lib/errorText';
import { DISCOUNT_REASONS, reasonLabel } from './discountReasons';

export function DiscountSheet({
  open,
  onClose,
  subtotalCents,
  adjustments,
  defaultMode,
  defaultReason,
  canRemove,
  offline,
  applying,
  removing,
  onApply,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  subtotalCents: number;
  adjustments: OrderAdjustment[];
  defaultMode: 'flat' | 'percent';
  defaultReason: string;
  canRemove: boolean;
  offline: boolean;
  applying: boolean;
  removing: boolean;
  onApply: (amountCents: number, reason: string) => Promise<void>;
  onRemove: (adjId: string) => void;
}) {
  const theme = useTheme();
  const [pct, setPct] = useState(defaultMode === 'percent');
  const [flatCents, setFlatCents] = useState(0);
  const [pctText, setPctText] = useState('');
  const [reason, setReason] = useState<string>(defaultReason);

  // The sheet stays mounted behind the ticket, so re-opening would otherwise
  // inherit the last discount's half-typed amount.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPct(defaultMode === 'percent');
      setFlatCents(0);
      setPctText('');
      setReason(defaultReason);
    }
  }

  const discounts = adjustments.filter((a) => a.type === 'discount');
  const cents = pct
    ? Math.round((subtotalCents * (parseFloat(pctText) || 0)) / 100)
    : flatCents;

  async function apply() {
    if (offline) {
      toast.error('Reconnect to discount this tab', 'Money changes need a connection.');
      return;
    }
    if (cents <= 0) {
      toast.error('Discount must be greater than zero');
      return;
    }
    if (cents > subtotalCents) {
      toast.error('That is more than the tab', 'A discount cannot exceed what is owed.');
      return;
    }
    try {
      await onApply(cents, reason);
      setFlatCents(0);
      setPctText('');
    } catch (e) {
      toast.error('Could not apply discount', errorText(e));
    }
  }

  return (
    <AppSheet
      open={open}
      onClose={onClose}
      title="Discount"
      size="medium"
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] }}>
          <Button
            title={cents > 0 ? `Apply −${formatNPR(cents)}` : 'Apply discount'}
            onPress={apply}
            loading={applying}
            disabled={offline}
          />
        </View>
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[4],
          gap: theme.spacing[4],
        }}
      >
        <View style={{ flexDirection: 'row', gap: theme.spacing[2] }}>
          <Chip label="Rs" selected={!pct} onPress={() => setPct(false)} testID="tab-discount-flat" />
          <Chip label="%" selected={pct} onPress={() => setPct(true)} testID="tab-discount-pct" />
        </View>

        {pct ? (
          <View style={{ gap: theme.spacing[2] }}>
            <AppText variant="label">Percent off</AppText>
            <AppSheet.TextInput
              value={pctText}
              onChangeText={setPctText}
              keyboardType="decimal-pad"
              placeholder="10"
              placeholderTextColor={theme.colors.textFaint}
              accessibilityLabel="tab-discount-percent"
              style={{
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.md,
                paddingHorizontal: theme.spacing[3],
                paddingVertical: theme.spacing[3],
                color: theme.colors.text,
                fontFamily: theme.fonts.mono,
              }}
            />
            {cents > 0 ? (
              <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                {pctText}% of {formatNPR(subtotalCents)} — {formatNPR(cents)} off
              </AppText>
            ) : null}
          </View>
        ) : (
          <AmountInput
            label="Amount off"
            valueCents={flatCents}
            onChangeCents={setFlatCents}
            insideSheet
            testID="tab-discount-amount"
          />
        )}

        <View style={{ gap: theme.spacing[2] }}>
          {/* A reason is required: it lands on the receipt and in the audit
              trail, so "why" must not default to a shrug. */}
          <AppText variant="label">Reason</AppText>
          <View style={{ flexDirection: 'row', gap: theme.spacing[2], flexWrap: 'wrap' }}>
            {DISCOUNT_REASONS.map((r) => (
              <Chip
                key={r.value}
                label={r.label}
                selected={reason === r.value}
                onPress={() => setReason(r.value)}
                testID={`tab-discount-reason-${r.value}`}
              />
            ))}
          </View>
        </View>

        {discounts.length > 0 ? (
          <View style={{ gap: theme.spacing[2] }}>
            <AppText variant="label">Already applied</AppText>
            {discounts.map((a) => (
              <ListRow
                key={a.id}
                title={`−${formatNPR(a.amount_cents)}`}
                subtitle={promotionLabel(a) ?? reasonLabel(a.reason)}
                right={
                  canRemove && !offline ? (
                    <Button
                      title=""
                      variant="ghost"
                      accessibilityLabel="remove-discount"
                      loading={removing}
                      icon={<Trash2 size={16} color={theme.colors.dangerFg} />}
                      onPress={() => onRemove(a.id)}
                    />
                  ) : undefined
                }
              />
            ))}
          </View>
        ) : null}

        {offline ? (
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            Discounts need a connection — they change what is owed, so they are never queued.
          </AppText>
        ) : null}
      </AppSheet.ScrollView>
    </AppSheet>
  );
}
