/**
 * Jump to a day.
 *
 * The arrows alone made "last month" a thirty-tap journey, which is how a
 * question like "what did the 3rd take?" quietly stops being asked. This is a
 * hand-rolled month grid rather than a date-picker dependency: the whole job is
 * seven columns and some day arithmetic, all of which lives — and is tested —
 * in `lib/dates`.
 *
 * Future days are inert. Nothing has closed on them, so a tap could only ever
 * land on an empty screen.
 */
import { useState } from 'react';
import { View, Pressable } from 'react-native';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppText, MonoText } from '@/components/ui/Text';
import { Chip } from '@/components/ui/Chip';
import { useTheme } from '@/theme';
import { todayStr, shiftDay, shiftMonth, monthLabel, monthMatrix, startOfMonth } from '@/lib/dates';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function DayJumpSheet({
  open,
  onClose,
  value,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  /** The day currently shown, YYYY-MM-DD. */
  value: string;
  onPick: (day: string) => void;
}) {
  const theme = useTheme();
  const today = todayStr();
  /** Which month the grid is showing — moves with the arrows without
   *  committing to a day, so browsing is free. */
  const [month, setMonth] = useState(value);

  // Re-open on the month of whatever day is being viewed, not wherever the
  // last browse happened to end up.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setMonth(value);
  }

  const pick = (day: string) => {
    onPick(day);
    onClose();
  };

  const weeks = monthMatrix(month);
  // Stepping forward past the current month would only show inert cells.
  const atCurrentMonth = startOfMonth(month) >= startOfMonth(today);

  return (
    <AppSheet open={open} onClose={onClose} title="Jump to a day" size="medium">
      <AppSheet.ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[6],
          gap: theme.spacing[4],
        }}
      >
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
          <Chip label="Today" selected={value === today} onPress={() => pick(today)} testID="jump-today" />
          <Chip
            label="Yesterday"
            selected={value === shiftDay(today, -1)}
            onPress={() => pick(shiftDay(today, -1))}
            testID="jump-yesterday"
          />
          <Chip
            label="A week ago"
            selected={value === shiftDay(today, -7)}
            onPress={() => pick(shiftDay(today, -7))}
            testID="jump-week"
          />
        </View>

        <View style={{ gap: theme.spacing[3] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
            <Pressable
              onPress={() => setMonth((m) => shiftMonth(m, -1))}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="previous-month"
            >
              <ChevronLeft size={20} color={theme.colors.textMuted} />
            </Pressable>
            <AppText style={{ flex: 1, textAlign: 'center', fontFamily: theme.fonts.bodySemi }}>
              {monthLabel(month)}
            </AppText>
            <Pressable
              onPress={() => setMonth((m) => shiftMonth(m, 1))}
              disabled={atCurrentMonth}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="next-month"
              accessibilityState={{ disabled: atCurrentMonth }}
            >
              <ChevronRight
                size={20}
                color={atCurrentMonth ? theme.colors.textFaint : theme.colors.textMuted}
              />
            </Pressable>
          </View>

          <View style={{ flexDirection: 'row' }}>
            {WEEKDAYS.map((d, i) => (
              <MonoText key={i} size="2xs" muted style={{ flex: 1, textAlign: 'center' }}>
                {d}
              </MonoText>
            ))}
          </View>

          {weeks.map((week, wi) => (
            <View key={wi} style={{ flexDirection: 'row' }}>
              {week.map((day, di) => (
                <DayCell
                  key={day ?? `blank-${di}`}
                  day={day}
                  selected={day === value}
                  isToday={day === today}
                  future={!!day && day > today}
                  onPress={pick}
                />
              ))}
            </View>
          ))}
        </View>
      </AppSheet.ScrollView>
    </AppSheet>
  );
}

function DayCell({
  day,
  selected,
  isToday,
  future,
  onPress,
}: {
  day: string | null;
  selected: boolean;
  isToday: boolean;
  future: boolean;
  onPress: (day: string) => void;
}) {
  const theme = useTheme();
  if (!day) return <View style={{ flex: 1, height: theme.touch.min }} />;

  const fg = selected
    ? theme.colors.stamp.brand.fg
    : future
      ? theme.colors.textFaint
      : theme.colors.text;

  return (
    <Pressable
      onPress={() => onPress(day)}
      disabled={future}
      accessibilityRole="button"
      accessibilityLabel={`day-${day}`}
      accessibilityState={{ selected, disabled: future }}
      style={{
        flex: 1,
        height: theme.touch.min,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radii.md,
        backgroundColor: selected ? theme.colors.primaryTint : 'transparent',
        borderWidth: isToday && !selected ? 1 : 0,
        borderColor: theme.colors.border,
      }}
    >
      <MonoText size="sm" style={{ color: fg }}>
        {Number(day.slice(8))}
      </MonoText>
    </Pressable>
  );
}
