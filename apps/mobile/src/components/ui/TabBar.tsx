/**
 * TabBar — custom bottom tab bar (replaces the stock expo-router bar): Lucide
 * icons via each route's `tabBarIcon`, mono uppercase labels, an amber pill
 * behind the active tab, haptic tap, safe-area aware. Wire it in the Tabs
 * layout with `tabBar={(props) => <TabBar {...props} />}` — permission-hidden
 * routes (`href: null`) are filtered out.
 */
import type { ReactNode } from 'react';
import { View, Pressable, Text } from 'react-native';
import Animated from 'react-native-reanimated';
import { haptics } from '../../lib/haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme';
import { enterFade } from '../../theme/motion';

/** Structural subset of @react-navigation/bottom-tabs' BottomTabBarProps —
 * kept local so the app doesn't depend on the package directly (it arrives
 * transitively via expo-router). */
export type TabBarProps = {
  state: { index: number; routes: { key: string; name: string }[] };
  descriptors: Record<
    string,
    {
      options: {
        title?: string;
        href?: unknown;
        tabBarIcon?: (p: { focused: boolean; color: string; size: number }) => ReactNode;
        tabBarAccessibilityLabel?: string;
        tabBarButtonTestID?: string;
      };
    }
  >;
  navigation: {
    emit: (e: {
      type: 'tabPress';
      target: string;
      canPreventDefault: true;
    }) => { defaultPrevented: boolean };
    navigate: (name: string) => void;
  };
};

export function TabBar({ state, descriptors, navigation }: TabBarProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const visible = state.routes.filter((route) => {
    const options = descriptors[route.key]?.options as { href?: unknown } | undefined;
    return options?.href !== null;
  });

  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: theme.colors.surfaces[1],
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingTop: theme.spacing[2],
        paddingHorizontal: theme.spacing[2],
        paddingBottom: Math.max(insets.bottom, theme.spacing[2]) + theme.spacing[1],
        gap: theme.spacing[1],
      }}
    >
      {visible.map((route) => {
        const { options } = descriptors[route.key];
        const focused = state.routes[state.index]?.key === route.key;
        const label = options.title ?? route.name;
        const color = focused ? theme.colors.stamp.brand.fg : theme.colors.textFaint;

        const onPress = () => {
          haptics.selection();
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
        };

        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
            testID={options.tabBarButtonTestID}
            onPress={onPress}
            style={{ flex: 1, minHeight: theme.touch.comfortable }}
          >
            <View style={{ alignItems: 'center', justifyContent: 'center', gap: 3, flex: 1 }}>
              {focused ? (
                <Animated.View
                  entering={enterFade}
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: theme.spacing[1],
                    right: theme.spacing[1],
                    backgroundColor: theme.colors.primaryTint,
                    borderRadius: theme.radii.md,
                  }}
                />
              ) : null}
              {options.tabBarIcon?.({ focused, color, size: 21 })}
              <Text
                style={{
                  color,
                  fontFamily: focused ? theme.fonts.monoBold : theme.fonts.monoMedium,
                  fontSize: 9.5,
                  letterSpacing: 0.8,
                  textTransform: 'uppercase',
                }}
              >
                {label}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
