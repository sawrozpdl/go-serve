/**
 * AmountInput — money entry as the hero: currency prefix + big tabular-mono
 * digits, decimal pad, optional quick-amount chips. Parsing reuses the
 * unit-tested helpers in src/catalog/money.ts (same rule the settle flow and
 * catalog forms already use).
 *
 * Set `insideSheet` when rendered in an AppSheet so the input registers with
 * gorhom's keyboard tracking (this is the money-field keyboard fix).
 */
import { useEffect, useRef, useState } from 'react';
import { TextInput, View, Text } from 'react-native';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useTheme } from '../../theme';
import { centsToPriceInput, parsePriceToCents } from '../../catalog/money';
import { AppText } from './Text';
import { Chip } from './Chip';

export type AmountInputProps = {
  /** Value in cents; null/0 renders the placeholder. */
  valueCents: number;
  onChangeCents: (cents: number) => void;
  label?: string;
  /** Placeholder amount in cents (e.g. the outstanding balance). */
  placeholderCents?: number;
  /** Quick-fill chips, in cents, labeled with `formatAmount`. */
  quickAmounts?: number[];
  formatAmount?: (cents: number) => string;
  currency?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  error?: string;
  insideSheet?: boolean;
  testID?: string;
};

export function AmountInput({
  valueCents,
  onChangeCents,
  label,
  placeholderCents,
  quickAmounts,
  formatAmount = (c) => `Rs ${(c / 100).toLocaleString()}`,
  currency = 'Rs',
  autoFocus,
  disabled,
  error,
  insideSheet = false,
  testID,
}: AmountInputProps) {
  const theme = useTheme();
  const [text, setText] = useState(() => centsToPriceInput(valueCents));
  const [focused, setFocused] = useState(false);
  const textRef = useRef(text);

  // Mirror the latest text into a ref post-commit (declared BEFORE the sync
  // effect below so same-commit reads are fresh; ref writes during render are
  // forbidden under the React Compiler).
  useEffect(() => {
    textRef.current = text;
  });

  // Sync when the parent resets the value from outside (e.g. after recording
  // a payment): only when the prop diverges from what the current text parses
  // to, so in-progress typing ("12.", "1,2") is never reformatted mid-keystroke.
  useEffect(() => {
    const current = textRef.current.trim() ? parsePriceToCents(textRef.current) : 0;
    if (valueCents !== current) setText(centsToPriceInput(valueCents));
  }, [valueCents]);

  const onChangeText = (t: string) => {
    setText(t);
    onChangeCents(t.trim() ? parsePriceToCents(t) : 0);
  };

  const Input = insideSheet ? BottomSheetTextInput : TextInput;
  const borderColor = error
    ? theme.colors.dangerFg
    : focused
      ? theme.colors.primary
      : theme.colors.border;

  return (
    <View style={{ gap: theme.spacing[2] }}>
      {label ? <AppText variant="label">{label}</AppText> : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing[2],
          backgroundColor: theme.colors.surfaces[2],
          borderWidth: focused || error ? 1.5 : 1,
          borderColor,
          borderRadius: theme.radii.md,
          paddingHorizontal: theme.spacing[4],
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text
          style={{
            color: theme.colors.textMuted,
            fontFamily: theme.fonts.monoMedium,
            fontSize: theme.text.xl,
          }}
        >
          {currency}
        </Text>
        <Input
          accessibilityLabel={label ?? 'amount'}
          testID={testID}
          value={text}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          keyboardType="decimal-pad"
          autoFocus={autoFocus}
          editable={!disabled}
          placeholder={placeholderCents != null ? centsToPriceInput(placeholderCents) || '0' : '0'}
          placeholderTextColor={theme.colors.textFaint}
          style={{
            flex: 1,
            color: theme.colors.text,
            fontFamily: theme.fonts.monoBold,
            fontSize: theme.text['3xl'],
            fontVariant: ['tabular-nums'],
            paddingVertical: theme.spacing[3],
            minHeight: theme.touch.comfortable + 8,
          }}
        />
      </View>
      {error ? (
        <AppText style={{ color: theme.colors.dangerFg, fontSize: theme.text.sm }}>{error}</AppText>
      ) : null}
      {quickAmounts && quickAmounts.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
          {quickAmounts.map((cents) => (
            <Chip
              key={cents}
              label={formatAmount(cents)}
              selected={valueCents === cents}
              disabled={disabled}
              onPress={() => {
                setText(centsToPriceInput(cents));
                onChangeCents(cents);
              }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
