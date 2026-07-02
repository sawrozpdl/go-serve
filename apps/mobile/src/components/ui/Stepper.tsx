/**
 * Stepper — THE quantity stepper, one implementation with real touch targets
 * (44dp md / 52dp lg incl. the buttons), replacing the 26px on-card and 32px
 * ticket-line steppers. Mono tabular value, haptic ticks, min/max clamping.
 */
import { View, Text, Pressable } from 'react-native';
import { Minus, Plus } from 'lucide-react-native';
import { useTheme } from '../../theme';
import { haptics } from '../../lib/haptics';

export type StepperProps = {
  value: number;
  onIncrement: () => void;
  onDecrement: () => void;
  min?: number;
  max?: number;
  size?: 'md' | 'lg';
  disabled?: boolean;
  /** Accessibility context, e.g. the item name. */
  label?: string;
};

export function Stepper({
  value,
  onIncrement,
  onDecrement,
  min = 0,
  max,
  size = 'md',
  disabled = false,
  label,
}: StepperProps) {
  const theme = useTheme();
  const side = size === 'lg' ? theme.touch.comfortable + 4 : theme.touch.min;
  const canDec = !disabled && value > min;
  const canInc = !disabled && (max == null || value < max);

  const btn = (kind: 'dec' | 'inc', enabled: boolean, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${kind === 'dec' ? 'decrease' : 'increase'}${label ? ` ${label}` : ''}`}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      hitSlop={4}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      style={({ pressed }) => ({
        width: side,
        height: side,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radii.md,
        backgroundColor: pressed && enabled ? theme.colors.primaryTint : 'transparent',
        opacity: enabled ? 1 : 0.35,
      })}
    >
      {kind === 'dec' ? (
        <Minus size={20} color={theme.colors.text} />
      ) : (
        <Plus size={20} color={theme.colors.stamp.brand.fg} />
      )}
    </Pressable>
  );

  return (
    <View
      accessibilityLabel={label ? `${label} quantity` : 'quantity'}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        backgroundColor: theme.colors.surfaces[2],
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radii.md + 2,
        overflow: 'hidden',
      }}
    >
      {btn('dec', canDec, onDecrement)}
      <Text
        accessibilityLabel={`quantity ${value}`}
        style={{
          minWidth: 34,
          textAlign: 'center',
          color: theme.colors.text,
          fontFamily: theme.fonts.monoBold,
          fontSize: theme.text.lg,
          fontVariant: ['tabular-nums'],
        }}
      >
        {value}
      </Text>
      {btn('inc', canInc, onIncrement)}
    </View>
  );
}
