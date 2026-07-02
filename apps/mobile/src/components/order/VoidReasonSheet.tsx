/**
 * VoidReasonSheet — confirm voiding a line that's already gone to the kitchen.
 * Sent items can't be removed silently (they may be cooking), so a reason is
 * required, mirroring web's VoidModal presets. Pending lines skip this (they use
 * the 1-tap Remove in the ticket).
 */
import { useState } from 'react';
import { View } from 'react-native';
import { AppSheet } from '../ui/AppSheet';
import { AppText } from '../ui/Text';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { useTheme } from '../../theme';

const REASONS = ['Customer changed mind', 'Wrong order', 'Dropped', 'Other'];

export function VoidReasonSheet({
  target,
  onClose,
  onConfirm,
}: {
  target: { id: string; name: string } | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const theme = useTheme();
  const [reason, setReason] = useState<string | null>(null);

  // Reset the picker on every exit (close or confirm) so the next line the user
  // voids starts fresh — avoids a set-state-in-effect on `target`.
  const close = () => {
    setReason(null);
    onClose();
  };

  return (
    <AppSheet open={!!target} onClose={close} title="Void item">
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4] }}>
        <AppText variant="muted">
          {target ? `${target.name} — sent to kitchen. Pick a reason.` : 'Pick a reason.'}
        </AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
          {REASONS.map((r) => (
            <Chip key={r} label={r} selected={reason === r} onPress={() => setReason(r)} />
          ))}
        </View>
        <Button
          title="Void item"
          variant="danger"
          disabled={!reason}
          onPress={() => {
            if (reason) onConfirm(reason);
            setReason(null);
          }}
        />
      </View>
    </AppSheet>
  );
}
