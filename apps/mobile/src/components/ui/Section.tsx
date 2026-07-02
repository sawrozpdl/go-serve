/**
 * Section — titled block with the Docket section label: mono uppercase
 * eyebrow trailing into a dotted leader ("WALK-INS · 2 ····––"), optional
 * count and right action. Replaces the per-screen `Section` implementations.
 */
import type { ReactNode } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useTheme } from '../../theme';
import { DottedLeader } from './DottedLeader';

export type SectionProps = {
  title: string;
  /** Rendered after the title as "TITLE · N". */
  count?: number;
  action?: { label: string; onPress: () => void };
  children: ReactNode;
  gap?: number;
  style?: object;
};

export function Section({ title, count, action, children, gap, style }: SectionProps) {
  const theme = useTheme();
  return (
    <View style={[{ gap: gap ?? theme.spacing[3] }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
        <Text
          accessibilityRole="header"
          style={{
            color: theme.colors.textMuted,
            fontFamily: theme.fonts.monoMedium,
            fontSize: theme.text['2xs'],
            letterSpacing: 1.6,
            textTransform: 'uppercase',
          }}
        >
          {count != null ? `${title} · ${count}` : title}
        </Text>
        <DottedLeader />
        {action ? (
          <Pressable onPress={action.onPress} hitSlop={10} accessibilityRole="button">
            <Text
              style={{
                color: theme.colors.stamp.brand.fg,
                fontFamily: theme.fonts.monoBold,
                fontSize: theme.text['2xs'],
                letterSpacing: 1,
                textTransform: 'uppercase',
              }}
            >
              {action.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  );
}
