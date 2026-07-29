/**
 * ReclassifySheet — confirm swapping a payment between cash and online, the fix
 * for "they settled it as online but the customer paid cash". Shared by the
 * Settle sheet (open tab) and History (already-settled order) so both surfaces
 * read the same.
 *
 * There is no method picker: the target is always the opposite channel, matching
 * web. The server refuses once the payment's shift has closed — the callers hide
 * the entry point by then, but the error is surfaced verbatim if it slips
 * through (e.g. a colleague closed the shift on another device).
 */
import { View } from 'react-native';
import { AppSheet } from '../ui/AppSheet';
import { AppText, MonoText } from '../ui/Text';
import { Button } from '../ui/Button';
import { useTheme } from '../../theme';
import { useReclassifyPayment } from '../../api/settle';
import { formatNPR } from '../../lib/format';
import { toast } from '../../lib/toast';
import { errorText } from '../../lib/errorText';
import { haptics } from '../../lib/haptics';

export type ReclassifyTarget = {
  orderId: string;
  paymentId: string;
  amountCents: number;
  /** The payment's current method, raw from the API ('cash' | 'other' | …). */
  method: string;
};

const NAME = { cash: 'Cash', online: 'Online' } as const;

export function ReclassifySheet({
  target,
  onClose,
}: {
  target: ReclassifyTarget | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const reclassify = useReclassifyPayment();

  // Anything that isn't cash and reached this sheet is an online-class payment
  // (credit charges are filtered out by the callers — they're tab ledger rows).
  const from = target?.method === 'cash' ? 'cash' : 'online';
  const to = from === 'cash' ? 'online' : 'cash';

  const confirm = () => {
    if (!target) return;
    haptics.selection();
    reclassify.mutate(
      { orderId: target.orderId, paymentId: target.paymentId, method: to },
      {
        onSuccess: () => {
          toast.success('Payment reclassified', `${formatNPR(target.amountCents)} is now ${to}`);
          onClose();
        },
        onError: (e) => toast.error('Could not reclassify', errorText(e)),
      },
    );
  };

  return (
    <AppSheet open={!!target} onClose={onClose} title="Change payment method">
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4] }}>
        <View style={{ gap: theme.spacing[1] }}>
          <MonoText weight="bold" size="xl">
            {formatNPR(target?.amountCents ?? 0)}
          </MonoText>
          <MonoText muted size="sm" style={{ letterSpacing: 1.2 }}>
            {NAME[from].toUpperCase()} → {NAME[to].toUpperCase()}
          </MonoText>
        </View>

        <AppText variant="muted">
          {to === 'online'
            ? "Takes it out of this shift's expected cash."
            : "Adds it to this shift's expected cash."}
        </AppText>

        <View style={{ gap: theme.spacing[2] }}>
          <Button
            title={`Switch to ${NAME[to]}`}
            onPress={confirm}
            loading={reclassify.isPending}
          />
          <Button title={`Keep as ${NAME[from]}`} variant="secondary" onPress={onClose} />
        </View>
      </View>
    </AppSheet>
  );
}
