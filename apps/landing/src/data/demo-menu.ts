/* Sample menu shared by the PosDemo island and the QR-menu phone mockup,
 * so the playground and the feature tour show the same cafe. */

export type DemoItem = {
  id: string;
  name: string;
  category: 'Espresso Bar' | 'Bakery' | 'Mains';
  price: number; // NPR
  emoji: string;
  popular?: boolean;
};

export const DEMO_CAFE = 'Himal Beans';

export const DEMO_MENU: DemoItem[] = [
  { id: 'espresso', name: 'Espresso', category: 'Espresso Bar', price: 180, emoji: '☕' },
  { id: 'cappuccino', name: 'Cappuccino', category: 'Espresso Bar', price: 220, emoji: '🥛', popular: true },
  { id: 'latte', name: 'Cafe Latte', category: 'Espresso Bar', price: 250, emoji: '🍮' },
  { id: 'mocha', name: 'Mocha', category: 'Espresso Bar', price: 280, emoji: '🍫' },
  { id: 'croissant', name: 'Butter Croissant', category: 'Bakery', price: 190, emoji: '🥐', popular: true },
  { id: 'brownie', name: 'Walnut Brownie', category: 'Bakery', price: 210, emoji: '🍰' },
  { id: 'banana-bread', name: 'Banana Bread', category: 'Bakery', price: 170, emoji: '🍌' },
  { id: 'momo', name: 'Chicken Momo', category: 'Mains', price: 320, emoji: '🥟', popular: true },
  { id: 'thukpa', name: 'Veg Thukpa', category: 'Mains', price: 280, emoji: '🍜' },
  { id: 'fried-rice', name: 'Cheese Fried Rice', category: 'Mains', price: 300, emoji: '🍚' },
];

export const DEMO_CATEGORIES = ['Espresso Bar', 'Bakery', 'Mains'] as const;

export function formatRs(n: number): string {
  return `Rs ${Number.isInteger(n) ? n.toLocaleString('en-IN') : n.toFixed(2)}`;
}
