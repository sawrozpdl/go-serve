/**
 * Send one item's stock to another branch (multi-branch). It leaves this
 * branch and arrives at the other in one go on the server, or not at all. The
 * receiving branch's item is matched by name; if it doesn't stock it yet, it
 * starts to, with this branch's unit and packs.
 */
import { useState } from 'react';
import { View, Pressable } from 'react-native';
import { Check } from 'lucide-react-native';
import type { InventoryItem } from '@cafe-mgmt/api-types';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { useTheme, type Theme } from '@/theme';
import { toast } from '@/lib/toast';
import { branchColor, branchLabel } from '@/lib/branches';
import { useCreateStockTransfer, useOverview } from '@/api/business';

const trimQty = (s: string) => s.replace(/\.?0+$/, '');

export function SendStockSheet({ item, onClose }: { item: InventoryItem; onClose: () => void }) {
  const theme = useTheme();
  const { business, branches } = useOverview();
  const send = useCreateStockTransfer();
  const targets = branches.filter((b) => !b.is_active);
  // Derived default, not a one-time initialiser: per-branch abilities may land
  // after the sheet mounts.
  const [chosen, setTo] = useState<string | null>(null);
  const to = chosen ?? targets.find((b) => b.can?.inventory_adjust)?.slug ?? '';
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const label = (n: string) => branchLabel(n, business?.name);

  const amount = parseFloat(qty.replace(/[^0-9.]/g, ''));
  const onHand = parseFloat(item.qty_on_hand_units);
  const problem = !to
    ? 'Pick a branch'
    : !Number.isFinite(amount) || amount <= 0
      ? 'Enter how much to send'
      : amount > onHand
        ? `Only ${trimQty(item.qty_on_hand_units)} ${item.sale_unit} on hand`
        : null;
  const target = targets.find((b) => b.slug === to);

  const submit = () => {
    if (problem) {
      toast.error(problem);
      return;
    }
    send.mutate(
      { to, note: note.trim() || undefined, lines: [{ inventory_item_id: item.id, qty_units: String(amount) }] },
      {
        onSuccess: (res) => {
          const created = res.lines.some((l) => l.created_at_destination);
          toast.success(
            `Sent ${amount} ${item.sale_unit} to ${label(res.to.name)}`,
            created ? `${label(res.to.name)} now stocks ${item.name}` : undefined,
          );
          onClose();
        },
        onError: (e) => toast.error('Could not send', (e as Error).message),
      },
    );
  };

  return (
    <AppSheet
      open
      onClose={onClose}
      title={`Send · ${item.name}`}
      full
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] }}>
          <Button
            title={target ? `Send to ${label(target.name)}` : 'Send'}
            onPress={submit}
            loading={send.isPending}
            disabled={!!problem}
          />
        </View>
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{ paddingHorizontal: theme.spacing[5], paddingBottom: theme.spacing[6], gap: theme.spacing[4] }}
      >
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          On hand here:{' '}
          <MonoText size="sm" muted>
            {trimQty(item.qty_on_hand_units)}
          </MonoText>{' '}
          {item.sale_unit}
        </AppText>

        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">To</AppText>
          {targets.map((b) => {
            const allowed = !!b.can?.inventory_adjust;
            const on = to === b.slug;
            return (
              <Pressable
                key={b.slug}
                disabled={!allowed}
                onPress={() => setTo(b.slug)}
                accessibilityRole="radio"
                accessibilityState={{ checked: on, disabled: !allowed }}
                testID={`send-to-${b.slug}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing[3],
                  minHeight: 48,
                  paddingHorizontal: theme.spacing[4],
                  borderRadius: theme.radii.md,
                  borderWidth: 1,
                  borderColor: on ? theme.colors.primary : theme.colors.border,
                  backgroundColor: on ? theme.colors.primaryTint : theme.colors.surface,
                  opacity: allowed ? 1 : 0.5,
                }}
              >
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: branchColor(branches, b.slug) }} />
                <AppText style={{ flex: 1, minWidth: 0 }} numberOfLines={1}>
                  {label(b.name)}
                </AppText>
                {!allowed ? (
                  <MonoText size="2xs" muted>
                    NO STOCK ACCESS
                  </MonoText>
                ) : on ? (
                  <Check size={18} color={theme.colors.primary} />
                ) : null}
              </Pressable>
            );
          })}
        </View>

        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">{`Quantity (${item.sale_unit})`}</AppText>
          <AppSheet.TextInput
            accessibilityLabel="Quantity to send"
            value={qty}
            onChangeText={setQty}
            placeholder="0"
            keyboardType="decimal-pad"
            placeholderTextColor={theme.colors.textFaint}
            style={inputStyle(theme)}
          />
          {problem && qty ? (
            <AppText style={{ fontSize: theme.text.sm, color: theme.colors.stamp.brand.fg }}>{problem}</AppText>
          ) : null}
        </View>

        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">Note (optional)</AppText>
          <AppSheet.TextInput
            accessibilityLabel="Note"
            value={note}
            onChangeText={setNote}
            placeholder="e.g. weekend top-up"
            placeholderTextColor={theme.colors.textFaint}
            style={inputStyle(theme)}
          />
        </View>
      </AppSheet.ScrollView>
    </AppSheet>
  );
}

function inputStyle(theme: Theme) {
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
