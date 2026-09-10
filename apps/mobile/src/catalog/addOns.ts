/**
 * Describing an add-on group in words.
 *
 * `min_select` / `max_select` are a rule, not two numbers, and the rule is
 * what an operator needs to see: "pick one" and "pick any" behave completely
 * differently at the POS, and `min_select >= 1` is the difference between an
 * optional extra and a line the cashier cannot add without answering.
 */
import type { ModifierGroup } from '@cafe-mgmt/api-types';

/** The pick rule as a sentence. */
export function groupRule(group: Pick<ModifierGroup, 'min_select' | 'max_select'>): string {
  const required = group.min_select > 0;
  // null / undefined / 0 all mean unlimited server-side.
  const unlimited = group.max_select == null || group.max_select < 1;

  if (required && unlimited) return 'Must pick at least one — any number allowed';
  if (required && group.max_select === 1) return 'Must pick exactly one';
  if (required) return `Must pick between ${group.min_select} and ${group.max_select}`;
  if (unlimited) return 'Optional — pick any number';
  if (group.max_select === 1) return 'Optional — pick at most one';
  return `Optional — pick up to ${group.max_select}`;
}

/**
 * Where the group is used. Reuse is the whole point of the add-on catalog, so
 * an operator about to change or delete one needs to know its blast radius
 * before they do it, not after.
 */
export function groupReuse(group: Pick<ModifierGroup, 'item_count' | 'category_count'>): string {
  const parts: string[] = [];
  if (group.item_count > 0) {
    parts.push(`${group.item_count} item${group.item_count === 1 ? '' : 's'}`);
  }
  if (group.category_count > 0) {
    parts.push(`${group.category_count} categor${group.category_count === 1 ? 'y' : 'ies'}`);
  }
  return parts.length === 0 ? 'Not attached to anything yet' : `Used on ${parts.join(' and ')}`;
}
