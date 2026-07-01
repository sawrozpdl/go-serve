/**
 * Menu/category icons — the mobile mirror of web's curated Lucide registry
 * (apps/web/src/components/icons.tsx). The server stores a plain name string
 * (e.g. "Coffee"); this resolves it to the matching lucide-react-native icon,
 * falling back to a small colored dot when the name is empty/unknown (same as
 * web's IconGlyph). Only the 54 curated names are imported to keep the bundle
 * lean.
 */
import { View } from 'react-native';
import type { ComponentType } from 'react';
import {
  Coffee, CupSoda, Beer, Wine, Martini, Citrus, Milk,
  Croissant, Cookie, IceCreamCone, IceCreamBowl, Cake, Donut, Popsicle,
  Pizza, Sandwich, Salad, Soup, Drumstick, Beef, Fish, Egg, EggFried,
  Apple, Cherry, Grape, Carrot, Wheat, Leaf, Sprout, Vegan, Flame,
  UtensilsCrossed, Utensils, ChefHat, CookingPot, ConciergeBell,
  Armchair, Sofa, BedDouble, Bed,
  Banknote, Receipt, CreditCard, Wallet,
  Tag, Tags, ShoppingBag, ShoppingCart, Package, Box, Gift,
  Star, Heart, Sparkles, Flag, Trophy, Smile, Sun, Moon, Snowflake, Zap,
  Music, Book, BookOpen, Crown, Diamond, Hexagon, Bookmark, Award, Bone,
} from 'lucide-react-native';
import { useTheme } from '../../theme';

type IconProps = { color?: string; size?: number; strokeWidth?: number };
type LucideIcon = ComponentType<IconProps>;

/** name → component. Matches web's ICON_REGISTRY keys 1:1. */
export const ICON_REGISTRY: Record<string, LucideIcon> = {
  Coffee, CupSoda, Beer, Wine, Martini, Citrus, Milk,
  Croissant, Cookie, IceCreamCone, IceCreamBowl, Cake, Donut, Popsicle,
  Pizza, Sandwich, Salad, Soup, Drumstick, Beef, Fish, Egg, EggFried,
  Apple, Cherry, Grape, Carrot, Wheat, Leaf, Sprout, Vegan, Flame,
  UtensilsCrossed, Utensils, ChefHat, CookingPot, ConciergeBell,
  Armchair, Sofa, BedDouble, Bed,
  Banknote, Receipt, CreditCard, Wallet,
  Tag, Tags, ShoppingBag, ShoppingCart, Package, Box, Gift,
  Star, Heart, Sparkles, Flag, Trophy, Smile, Sun, Moon, Snowflake, Zap,
  Music, Book, BookOpen, Crown, Diamond, Hexagon, Bookmark, Award, Bone,
};

export function getIconComponent(name: string | undefined): LucideIcon | null {
  if (!name) return null;
  return ICON_REGISTRY[name] ?? null;
}

/** Render a stored icon name, or a colored dot fallback. */
export function AppIcon({
  name,
  size = 20,
  color,
  strokeWidth = 2,
}: {
  name?: string;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const theme = useTheme();
  const tint = color ?? theme.colors.text;
  const Cmp = getIconComponent(name);
  // Intentional dynamic render from a STATIC registry (not a per-render
  // component) — the compiler heuristic can't see that, so opt out here.
  // eslint-disable-next-line react-hooks/static-components
  if (Cmp) return <Cmp size={size} color={tint} strokeWidth={strokeWidth} />;
  const dot = Math.max(6, Math.round(size * 0.4));
  return <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color ?? theme.colors.textFaint }} />;
}
