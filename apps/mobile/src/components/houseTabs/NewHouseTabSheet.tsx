/**
 * NewHouseTabSheet — create a customer credit account (e.g. "Owner A", "Staff
 * meals"). Mirrors web's NewTabModal: name + optional phone + notes + an
 * optional opening balance for money already owed before this app tracked it.
 * "House tab" stays the backend name; the UI calls it "Credit".
 */
import { useState } from 'react';
import { View } from 'react-native';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { AmountInput } from '@/components/ui/AmountInput';
import { useTheme, type Theme } from '@/theme';
import { useCreateHouseTab } from '@/api/houseTabs';
import { useConnectivity } from '@/stores/connectivity';
import { toast } from '@/lib/toast';

export function NewHouseTabSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useTheme();
  const offline = useConnectivity((s) => s.mode === 'offline');
  const create = useCreateHouseTab();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [openingCents, setOpeningCents] = useState(0);

  const reset = () => {
    setName('');
    setPhone('');
    setNotes('');
    setOpeningCents(0);
  };

  async function submit() {
    if (offline) return toast.error('Offline', 'Creating a credit account needs a connection.');
    if (!name.trim()) return;
    try {
      await create.mutateAsync({
        name: name.trim(),
        contact_phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
        opening_balance_cents: openingCents > 0 ? openingCents : undefined,
      });
      toast.success('Credit account created', name.trim());
      reset();
      onClose();
    } catch (e) {
      toast.error('Could not create account', (e as Error).message);
    }
  }

  return (
    <AppSheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="New credit"
    >
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[3], paddingBottom: theme.spacing[2] }}>
        <AppSheet.TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Owner A, Staff meals, Supplier loan"
          placeholderTextColor={theme.colors.textFaint}
          accessibilityLabel="new-house-tab-name"
          autoFocus
          style={fieldStyle(theme)}
        />
        <AppSheet.TextInput
          value={phone}
          onChangeText={setPhone}
          placeholder="Phone (optional)"
          placeholderTextColor={theme.colors.textFaint}
          accessibilityLabel="new-house-tab-phone"
          keyboardType="phone-pad"
          style={fieldStyle(theme)}
        />
        <AppSheet.TextInput
          value={notes}
          onChangeText={setNotes}
          placeholder="Notes (optional)"
          placeholderTextColor={theme.colors.textFaint}
          accessibilityLabel="new-house-tab-notes"
          style={fieldStyle(theme)}
        />
        <AmountInput
          label="Opening balance owed (optional)"
          valueCents={openingCents}
          onChangeCents={setOpeningCents}
          insideSheet
          testID="new-house-tab-opening-balance"
        />
        <AppText variant="muted" style={{ fontSize: theme.text.sm }}>
          If this customer already owed you money before you started using this app, enter it
          here — it&apos;ll show up as the account&apos;s starting balance.
        </AppText>
        <Button
          title="Create"
          onPress={submit}
          loading={create.isPending}
          disabled={!name.trim() || offline}
        />
      </View>
    </AppSheet>
  );
}

function fieldStyle(theme: Theme) {
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
