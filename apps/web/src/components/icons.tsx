// Curated lucide-react icon registry for menus, items, and tables.
//
// Why a curated subset rather than the full lucide module:
//   - Lucide ships ~1500 icons. A picker that shows them all is overwhelming
//     and most have no use here (`Anchor`, `Atom`, `Biohazard`…).
//   - Server stores the raw name string — the registry is the FE-only
//     allow-list / lookup table.
//   - Grouping keeps the picker scannable.

import {
  // Food + drinks
  Coffee, CupSoda, Beer, Wine, Martini, Citrus, Milk,
  Croissant, Pizza, Sandwich, Cookie, IceCreamCone, IceCreamBowl, Cake, Donut,
  Salad, Soup, Drumstick, Beef, Fish, Egg, Apple, Cherry, Grape, Carrot,
  Wheat, Vegan, Leaf, Sprout, Flame, Popsicle, EggFried,
  // Service / hospitality
  UtensilsCrossed, Utensils, ChefHat, CookingPot,
  ConciergeBell, Soup as SoupAlt,
  // Tables / seating
  Armchair, Sofa, BedDouble, Bed,
  // Generic / utility
  Tag, Star, Heart, Sparkles, Flag, Trophy, Smile, Sun, Moon,
  Snowflake, Zap, Gift, ShoppingBag, ShoppingCart, Package, Box, Tags,
  // Money / receipts
  Banknote, Receipt, CreditCard, Wallet,
  // Misc
  Music, Book, BookOpen, Crown, Diamond, Hexagon,
  Bookmark, Award, Bone, Pizza as PizzaAlt,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** The flat name→component map. Server stores the name; UI renders the icon. */
export const ICON_REGISTRY: Record<string, LucideIcon> = {
  // Drinks
  Coffee, CupSoda, Beer, Wine, Martini, Citrus, Milk,
  // Pastry + dessert
  Croissant, Cookie, IceCreamCone, IceCreamBowl, Cake, Donut, Popsicle,
  // Mains
  Pizza, Sandwich, Salad, Soup, Drumstick, Beef, Fish, Egg, EggFried,
  // Produce
  Apple, Cherry, Grape, Carrot, Wheat, Leaf, Sprout, Vegan, Flame,
  // Service
  UtensilsCrossed, Utensils, ChefHat, CookingPot, ConciergeBell,
  // Seating
  Armchair, Sofa, BedDouble, Bed,
  // Money + receipts
  Banknote, Receipt, CreditCard, Wallet,
  // Retail
  Tag, Tags, ShoppingBag, ShoppingCart, Package, Box, Gift,
  // Decorative
  Star, Heart, Sparkles, Flag, Trophy, Smile, Sun, Moon, Snowflake, Zap,
  Music, Book, BookOpen, Crown, Diamond, Hexagon, Bookmark, Award, Bone,
};

/** Grouped layout for the picker UI. Names match keys in ICON_REGISTRY. */
export const ICON_GROUPS: { label: string; names: string[] }[] = [
  {
    label: 'Drinks',
    names: ['Coffee', 'CupSoda', 'Beer', 'Wine', 'Martini', 'Citrus', 'Milk'],
  },
  {
    label: 'Bakery & sweets',
    names: ['Croissant', 'Cookie', 'IceCreamCone', 'IceCreamBowl', 'Cake', 'Donut', 'Popsicle'],
  },
  {
    label: 'Mains',
    names: ['Pizza', 'Sandwich', 'Salad', 'Soup', 'Drumstick', 'Beef', 'Fish', 'Egg', 'EggFried'],
  },
  {
    label: 'Produce',
    names: ['Apple', 'Cherry', 'Grape', 'Carrot', 'Wheat', 'Leaf', 'Sprout', 'Vegan', 'Flame'],
  },
  {
    label: 'Service',
    names: ['UtensilsCrossed', 'Utensils', 'ChefHat', 'CookingPot', 'ConciergeBell'],
  },
  {
    label: 'Seating',
    names: ['Armchair', 'Sofa', 'BedDouble', 'Bed'],
  },
  {
    label: 'Money & retail',
    names: ['Banknote', 'Receipt', 'CreditCard', 'Wallet', 'Tag', 'Tags', 'ShoppingBag', 'ShoppingCart', 'Package', 'Box', 'Gift'],
  },
  {
    label: 'Decorative',
    names: ['Star', 'Heart', 'Sparkles', 'Flag', 'Trophy', 'Smile', 'Sun', 'Moon', 'Snowflake', 'Zap', 'Music', 'Book', 'BookOpen', 'Crown', 'Diamond', 'Hexagon', 'Bookmark', 'Award', 'Bone'],
  },
];

/** Render the icon for a stored name. Returns null when name is empty or
 *  not in the registry (so callers can fall back to a default glyph or
 *  color dot). */
export function getIconComponent(name: string): LucideIcon | null {
  if (!name) return null;
  return ICON_REGISTRY[name] ?? null;
}

// Make the alt-imports referenced by the bundler. (Prevents "imported but
// unused" if the linter ever gets aggressive.)
void SoupAlt;
void PizzaAlt;
