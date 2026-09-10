/**
 * The POS behaviour toggles that live on `tenant.preferences`.
 *
 * Kept as data rather than JSX so the list is one thing in one place: the
 * hub counts them, the screen renders them, and a new preference is a row
 * here rather than an edit in two files that can disagree.
 *
 * `defaultOn` matters. An unset preference is `undefined`, not `false`, and
 * several of these ship ON — reading a missing key as off would silently
 * change how the POS behaves for every cafe that has never opened Settings.
 */
import type { TenantPreferences } from '@cafe-mgmt/api-types';

export type ToggleSpec = {
  key: keyof TenantPreferences;
  label: string;
  hint: string;
  defaultOn?: boolean;
};

export const TOGGLES: ToggleSpec[] = [
  {
    key: 'stackItems',
    label: 'Stack repeat items',
    hint: 'Re-tapping an item bumps its qty instead of a new line',
    defaultOn: true,
  },
  {
    key: 'autoReadyOnSend',
    label: 'Skip the cook step',
    hint: 'Items land "ready" on send rather than in progress',
  },
  {
    key: 'autoServeOnReady',
    label: 'Auto-serve when ready',
    hint: 'Marking ready also marks served',
    defaultOn: true,
  },
  {
    key: 'autoCleanTables',
    label: 'Auto-clean tables',
    hint: 'Closing a tab frees the table (no dirty sweep)',
  },
  {
    key: 'combinedSettle',
    label: 'Discounts in settle',
    hint: 'Show discount controls inside the settle sheet',
  },
  {
    key: 'requireTxnRef',
    label: 'Require online reference',
    hint: 'Ask for a txn reference on online payments',
  },
  {
    key: 'autoRecordPayment',
    label: 'Auto-record payments',
    hint: 'Typing an amount records it after a pause — no "Add payment" tap',
    defaultOn: true,
  },
  {
    key: 'dailyBriefEmail',
    label: 'Morning brief email',
    // Deliberately precise: this stops the MAIL, not the checking. The
    // findings are computed either way and still shown in the app.
    hint: 'Email what the nightly check found. Off just stops the email.',
    defaultOn: true,
  },
];

/** A toggle's effective value, honouring its default when unset. */
export function toggleValue(prefs: TenantPreferences | undefined, spec: ToggleSpec): boolean {
  const v = prefs?.[spec.key];
  return typeof v === 'boolean' ? v : !!spec.defaultOn;
}

/** How many depart from their default — what the hub row summarises. */
export function changedToggleCount(prefs: TenantPreferences | undefined): number {
  return TOGGLES.filter((t) => toggleValue(prefs, t) !== !!t.defaultOn).length;
}
