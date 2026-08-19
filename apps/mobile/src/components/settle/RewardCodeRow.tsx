/**
 * The till end of QR rewards, on mobile.
 *
 * Redemption only — campaigns and analytics are web-only in v1. Two deliberate
 * choices, matching the web POS:
 *
 *   * look up first, apply on a second explicit tap. Nothing that moves money
 *     happens while the cashier is still typing, and the preview shows the
 *     amount AFTER clamping so what they see is what comes off.
 *   * errors are sentences, never error kinds — a cashier reads these with a
 *     guest standing in front of them.
 *
 * Redemption is NEVER queued offline: a double-redeem is real money, and the
 * offline queue cannot check a code against the server.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { Gift } from 'lucide-react-native';

import { AppSheet } from '../ui/AppSheet';
import { AppText, MonoText } from '../ui/Text';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { useTheme, type Theme } from '../../theme';
import { formatNPR } from '../../lib/format';
import { haptics } from '../../lib/haptics';
import { toast } from '../../lib/toast';
import {
  humanRewardError,
  useLookupRewardCode,
  useRedeemRewardCode,
  type RewardLookup,
} from '../../api/engage';

// Mirrors SettleSheet's own fieldStyle so this row is visually indistinguishable
// from the discount field beside it.
function fieldStyle(theme: Theme, extra: Record<string, unknown> = {}) {
  return {
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaces[2],
    borderRadius: theme.radii.md,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    fontFamily: theme.fonts.body,
    borderWidth: 1,
    borderColor: theme.colors.border,
    // Codes are read aloud off a guest's phone, so tracking makes a mistyped
    // character obvious before Apply is tapped.
    letterSpacing: 2,
    ...extra,
  };
}

export function RewardCodeRow({
  orderId,
  offline,
  onApplied,
}: {
  orderId: string;
  offline: boolean;
  onApplied?: () => void;
}) {
  const theme = useTheme();
  const lookup = useLookupRewardCode();
  const redeem = useRedeemRewardCode();

  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<RewardLookup | null>(null);

  const reset = () => {
    setOpen(false);
    setCode('');
    setPreview(null);
  };

  const check = async () => {
    if (!code.trim()) return;
    if (offline) {
      toast.error('Offline', 'Reward codes need a connection.');
      return;
    }
    try {
      const found = await lookup.mutateAsync({ code: code.trim(), orderId });
      setPreview(found);
      if (!found.redeemable) {
        toast.error('Not usable', found.blocked_reason ?? 'That code cannot be used here.');
      }
    } catch (e) {
      const err = e as { code?: string; message?: string };
      // The field KEEPS its text so a typo can be corrected rather than retyped.
      toast.error('Reward code', humanRewardError(err.code ?? '', err.message ?? ''));
    }
  };

  const apply = async () => {
    if (offline) {
      toast.error('Offline', 'Reward codes need a connection.');
      return;
    }
    try {
      const res = await redeem.mutateAsync({ code: code.trim(), orderId });
      haptics.notifySuccess();
      toast.success('Reward applied', `${res.label} — ${formatNPR(res.amount_cents)} off`);
      reset();
      onApplied?.();
    } catch (e) {
      const err = e as { code?: string; message?: string };
      toast.error('Reward code', humanRewardError(err.code ?? '', err.message ?? ''));
    }
  };

  if (!open) {
    return (
      <Chip
        label="🎟  Reward code"
        onPress={() => setOpen(true)}
        testID="add-reward-code"
      />
    );
  }

  return (
    <View style={{ gap: theme.spacing[2] }}>
      <View style={{ flexDirection: 'row', gap: theme.spacing[2], alignItems: 'center' }}>
        <Gift size={16} color={theme.colors.textMuted} strokeWidth={1.6} />
        <AppSheet.TextInput
          value={code}
          onChangeText={(v: string) => {
            setCode(v.toUpperCase());
            setPreview(null);
          }}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={12}
          placeholder="TEA-7K2M"
          placeholderTextColor={theme.colors.textFaint}
          accessibilityLabel="reward-code"
          testID="reward-code-input"
          style={fieldStyle(theme, { flex: 1 })}
        />
        <View style={{ width: 92 }}>
          {preview?.redeemable ? (
            <Button title="Apply" onPress={apply} loading={redeem.isPending} testID="reward-code-apply" />
          ) : (
            <Button title="Check" onPress={check} loading={lookup.isPending} testID="reward-code-check" />
          )}
        </View>
      </View>

      {preview?.redeemable ? (
        <View style={{ gap: 2 }}>
          <AppText style={{ fontWeight: '600' }}>{preview.label}</AppText>
          {preview.applies_cents !== undefined ? (
            <MonoText style={{ color: theme.colors.stamp.success.fg }}>
              −{formatNPR(preview.applies_cents)}
              {preview.would_clamp ? '  (capped at the bill total)' : ''}
            </MonoText>
          ) : null}
          {preview.needs_grace_override ? (
            <AppText style={{ fontSize: 12, color: theme.colors.stamp.warn.fg }}>
              Expired {Math.abs(Math.round(preview.seconds_left / 60))} min ago — applying it is
              recorded as an override.
            </AppText>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
