/**
 * Everything the expense form needs to know about where the money can come
 * from: whether a shift is open, what the bank holds, who the owners are, and
 * how much cafe cash each of them is carrying.
 *
 * Bundled into one hook so the form stays a form. All four reads are gated so
 * a cafe whose plan or role can't reach owner finance simply never asks — a
 * 403 per render is not a graceful degradation.
 *
 * `enabled` is the sheet's own open state: none of this is worth fetching for
 * a screen the operator hasn't opened the form on.
 */
import type { Me } from '@cafe-mgmt/api-types';
import { can, hasFeature } from '@/auth/permissions';
import { useCurrentShift } from '@/api/shift';
import { useCafeOwners, useOwnerCash, useCafeBalance } from '@/api/finance';

export function useExpenseFunding(me: Me | null | undefined, enabled: boolean) {
  const canReadShift = can(me, 'shift:read');
  const canReadFinance = can(me, 'finance:read');
  // Owners and owner-cash sit behind the owner_finance plan feature; the
  // cafe-balance read does not.
  const ownerFinance = canReadFinance && hasFeature(me, 'owner_finance');

  const shift = useCurrentShift({ enabled: enabled && canReadShift });
  const owners = useCafeOwners({ enabled: enabled && ownerFinance });
  const ownerCash = useOwnerCash({ enabled: enabled && ownerFinance });
  const balance = useCafeBalance({ enabled: enabled && canReadFinance });

  const ownerList = owners.data ?? [];

  const shiftIsOpen = !!shift.data && !shift.data.closed_at;
  // Until the shift read settles we do NOT know, and "not yet loaded" must not
  // look like "closed" — that flipped the default source to Bank on every open
  // and buried the till-paid case the drawer exists for.
  const shiftKnown = canReadShift && shift.isSuccess;

  return {
    /** Drawer is only spendable while a shift is open — otherwise there is no
     *  drawer to take it out of, and the server answers 409 shift_required. */
    shiftIsOpen,
    /**
     * True only when we have positively established there is no open shift.
     * A member who may record an expense but not read shifts gets an enabled
     * drawer tile and, at worst, the server's own refusal — guessing on their
     * behalf would bar the common case on no evidence.
     */
    drawerBlocked: shiftKnown && !shiftIsOpen,
    shiftKnown,
    bankCents: balance.data?.bank_cents ?? 0,
    knowsBank: canReadFinance && balance.isSuccess,
    owners: ownerList,
    /** Owner sources are only offered when this cafe can actually record one. */
    showOwnerSources: ownerFinance && ownerList.length > 0,
    /** Cafe cash the given owner is currently holding. */
    heldBy: (ownerId: string) =>
      ownerCash.data?.holdings.find((h) => h.owner_id === ownerId)?.holding_cents ?? 0,
    knowsHoldings: ownerCash.isSuccess,
  };
}
