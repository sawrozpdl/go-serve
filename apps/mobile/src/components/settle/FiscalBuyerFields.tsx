/**
 * Optional buyer block on an IRD invoice (cafés in fiscal mode only). A walk-in
 * guest leaves it closed; a business guest gives its PAN to claim input VAT.
 * Collapsed by default so the common settle stays one tap. Mirrors web
 * FiscalBuyerFields; the server re-checks the PAN.
 *
 * Inputs are AppSheet.TextInput — this lives inside the settle sheet, whose
 * keyboard tracking only works for the sheet's own inputs.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { normalizePAN, type FiscalBuyer } from '@cafe-mgmt/api-types';
import { AppSheet } from '../ui/AppSheet';
import { AppText } from '../ui/Text';
import { Chip } from '../ui/Chip';
import { useTheme, type Theme } from '../../theme';

export function FiscalBuyerFields({
  value,
  onChange,
}: {
  value: FiscalBuyer;
  onChange: (b: FiscalBuyer) => void;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(!!(value.name || value.pan));
  const panBad = !!value.pan?.trim() && !normalizePAN(value.pan);
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <View style={{ gap: theme.spacing[2] }}>
      <Chip
        label={value.pan?.trim() ? `Buyer on the invoice · PAN ${value.pan.trim()}` : 'Buyer on the invoice (optional)'}
        icon={<Icon size={13} color={theme.colors.textMuted} />}
        selected={open}
        onPress={() => setOpen((o) => !o)}
        testID="fiscal-buyer-toggle"
      />
      {open ? (
        <View style={{ gap: theme.spacing[2] }}>
          <AppSheet.TextInput
            value={value.name ?? ''}
            onChangeText={(name) => onChange({ ...value, name })}
            placeholder="Buyer name, e.g. Acme Traders Pvt. Ltd."
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="buyer-name"
            maxLength={200}
            style={fieldStyle(theme)}
          />
          <AppSheet.TextInput
            value={value.pan ?? ''}
            onChangeText={(pan) => onChange({ ...value, pan })}
            placeholder="Buyer PAN / VAT no. (9 digits)"
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="buyer-pan"
            keyboardType="number-pad"
            maxLength={11}
            style={fieldStyle(theme, panBad ? { borderColor: theme.colors.dangerFg } : undefined)}
          />
          {panBad ? (
            <AppText style={{ fontSize: theme.text.sm, color: theme.colors.dangerFg }}>
              PAN must be 9 digits.
            </AppText>
          ) : null}
          <AppSheet.TextInput
            value={value.address ?? ''}
            onChangeText={(address) => onChange({ ...value, address })}
            placeholder="Buyer address (optional)"
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="buyer-address"
            maxLength={300}
            style={fieldStyle(theme)}
          />
        </View>
      ) : null}
    </View>
  );
}

function fieldStyle(theme: Theme, extra?: object) {
  return {
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaces[2],
    borderRadius: theme.radii.md,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    fontFamily: theme.fonts.body,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...extra,
  };
}
