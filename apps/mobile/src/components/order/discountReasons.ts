/**
 * The reasons a discount can be given.
 *
 * Shared by the ticket's DiscountSheet and the settle sheet, and matching web's
 * DiscountModal exactly — the value lands on the receipt and in the audit
 * trail, so the two clients must not invent different vocabularies for the same
 * act.
 */
export const DISCOUNT_REASONS = [
  { value: 'regular', label: 'Regular' },
  { value: 'promotion', label: 'Promotion' },
  { value: 'birthday', label: 'Birthday' },
  { value: 'staff', label: 'Staff' },
  { value: 'friends', label: 'Friends' },
  { value: 'other', label: 'Other' },
] as const;

/** Human label for a stored reason. An unknown value — an older row, or one a
 *  future web build adds — is shown as-is rather than silently swallowed. */
export function reasonLabel(reason: string): string {
  return DISCOUNT_REASONS.find((r) => r.value === reason)?.label ?? reason;
}
