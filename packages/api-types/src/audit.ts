// Tenant audit-log DTOs.
export type AuditEvent = {
  id: string;
  actor_id?: string | null;
  actor_name: string;
  actor_email: string;
  role_snap: string[];
  action: string;
  entity: string;
  entity_id?: string | null;
  summary: string;
  ip?: string | null;
  request_id: string;
  created_at: string;
};

export type AuditActor = {
  actor_id?: string | null;
  actor_name: string;
  actor_email: string;
};

export type AuditFilters = {
  actor?: string[];
  entity?: string[];
  action?: string[];
  from?: string;
  to?: string;
  q?: string;
};
