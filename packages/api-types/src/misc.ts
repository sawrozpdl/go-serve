// Bug / feedback reporting DTOs.
export type BugKind = 'bug' | 'idea' | 'question' | 'other';

export type BugStatus = 'open' | 'in_progress' | 'resolved' | 'wont_fix' | 'closed';

export type BugPriority = 'low' | 'normal' | 'high' | 'urgent';

export type BugReportInput = {
  kind: BugKind;
  mood?: number; // 1..5
  title?: string;
  description: string;
  files: File[];
};

export type MyBugReport = {
  id: string;
  kind: BugKind;
  mood?: number;
  title: string;
  description: string;
  status: BugStatus;
  priority: BugPriority;
  attachment_count: number;
  created_at: string;
  updated_at: string;
};

export type AdminBugReport = {
  id: string;
  tenant_slug: string;
  cafe_name: string;
  reporter_name: string;
  reporter_email: string;
  kind: BugKind;
  mood?: number;
  title: string;
  description: string;
  status: BugStatus;
  priority: BugPriority;
  attachment_count: number;
  created_at: string;
  updated_at: string;
};

export type AdminBugAttachment = {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

export type AdminBugReportDetail = AdminBugReport & {
  page_url: string;
  app_version: string;
  user_agent: string;
  viewport: string;
  resolution_note: string;
  resolved_at?: string;
  attachments: AdminBugAttachment[];
};

export type BugReportFilters = {
  status?: string;
  kind?: string;
  priority?: string;
  q?: string;
  sort?: string;
};

export type AdminBugReportsResponse = {
  reports: AdminBugReport[];
  summary: { open: number; in_progress: number; resolved: number; total: number };
};
