// Staff registry DTOs.
/** Weekly recurring shift template: day index "0"(Sun)–"6"(Sat) → time range.
 * A missing key means the staff member is off that day. */
export type StaffSchedule = Record<string, { start: string; end: string }>;

export type SalaryCadence = 'monthly' | 'hourly' | 'per_shift';

export type Staff = {
  id: string;
  full_name: string;
  role_title: string;
  phone: string;
  email?: string;
  status: 'active' | 'inactive';
  started_on?: string; // "YYYY-MM-DD"
  ended_on?: string; // "YYYY-MM-DD"
  salary_amount?: number;
  salary_cadence: SalaryCadence;
  schedule: StaffSchedule;
  user_id?: string; // linked team-member account
  user_email?: string; // display only
  user_name?: string; // display only
  notes: string;
  created_at: string;
  updated_at: string;
  doc_count: number;
};

export type StaffPay = {
  id: string;
  staff_id: string;
  paid_on: string; // "YYYY-MM-DD"
  amount: number;
  period_label: string;
  note: string;
  created_at: string;
};

export type StaffPayInput = {
  paid_on: string;
  amount: number;
  period_label?: string;
  note?: string;
};

export type StaffDocument = {
  id: string;
  staff_id: string;
  doc_type: string;
  label: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

export type StaffDetail = Staff & { documents: StaffDocument[] };

export type StaffInput = {
  full_name: string;
  role_title?: string;
  phone?: string;
  email?: string;
  status?: 'active' | 'inactive';
  started_on?: string | null;
  ended_on?: string | null;
  salary_amount?: number | null;
  salary_cadence?: SalaryCadence;
  schedule?: StaffSchedule;
  user_id?: string | null;
  /** Explicitly unlink the team member (a nil user_id alone means "unchanged"). */
  clear_user_id?: boolean;
  notes?: string;
};
