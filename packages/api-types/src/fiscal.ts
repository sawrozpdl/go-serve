// IRD electronic billing (docs/ird/COMPLIANCE.md). Migration 0089 onward.

/** How a café is registered with IRD. */
export type FiscalRegistration = 'none' | 'pan' | 'vat';

/** Non-secret fiscal status every member sees on /v1/me. */
export type FiscalSummary = {
  registration_type: FiscalRegistration;
  /** True once the café has switched on IRD invoicing (one-way). */
  fiscal_mode: boolean;
  pan?: string;
  legal_name?: string;
};

/** One reason a café cannot (yet) switch on fiscal mode. */
export type FiscalProblem = {
  code: string;
  field?: string;
  message: string;
};

/** Owner-facing profile: GET/PATCH /v1/fiscal/profile. */
export type FiscalProfile = {
  registration_type: FiscalRegistration;
  pan: string;
  legal_name: string;
  legal_name_ne: string;
  address: string;
  phone: string;
  email: string;
  tax_office: string;
  permit_no: string;
  outlet_code: string;
  fiscal_mode: boolean;
  fiscal_mode_enabled_at: string | null;
  cbms_enabled: boolean;
  cbms_username: string;
  /** Whether a CBMS password is stored; the password itself is never returned. */
  cbms_password_set: boolean;
  /** Empty once fiscal mode is on, or when nothing blocks enabling it. */
  readiness: FiscalProblem[];
};

export type FiscalProfilePatch = Partial<
  Pick<
    FiscalProfile,
    | 'registration_type'
    | 'pan'
    | 'legal_name'
    | 'legal_name_ne'
    | 'address'
    | 'phone'
    | 'email'
    | 'tax_office'
    | 'permit_no'
    | 'outlet_code'
  >
>;

/** Accepts "601234567" or "601-234-567"; returns the 9 digits or null. */
export function normalizePAN(input: string): string | null {
  const s = input.replace(/[\s-]/g, '');
  return /^[0-9]{9}$/.test(s) ? s : null;
}
