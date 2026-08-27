import { z } from 'zod';

// ---------------------------------------------------------------------------
// Audit logs & activity monitoring
// ---------------------------------------------------------------------------

export const AUDIT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type AuditSeverityValue = (typeof AUDIT_SEVERITIES)[number];

export const AUDIT_SEVERITY_LABELS: Record<AuditSeverityValue, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

export const AUDIT_STATUSES = ['SUCCESS', 'FAILED'] as const;
export type AuditStatusValue = (typeof AUDIT_STATUSES)[number];

/** Tabs across the log table — each is a saved filter over the same data. */
export const AUDIT_TABS = [
  'ALL',
  'ADMIN',
  'LOGIN',
  'DATA_CHANGE',
  'SECURITY',
  'SYSTEM',
] as const;
export type AuditTab = (typeof AUDIT_TABS)[number];

export const AUDIT_TAB_LABELS: Record<AuditTab, string> = {
  ALL: 'Activity logs',
  ADMIN: 'Admin logs',
  LOGIN: 'Login logs',
  DATA_CHANGE: 'Data changes',
  SECURITY: 'Security logs',
  SYSTEM: 'System logs',
};

export const AUDIT_TAB_HINTS: Record<AuditTab, string> = {
  ALL: 'Everything recorded across the platform',
  ADMIN: 'Actions taken by admin accounts',
  LOGIN: 'Sign-in attempts, successful and failed',
  DATA_CHANGE: 'Creates, updates and deletions of records',
  SECURITY: 'Failures, high-severity and critical events',
  SYSTEM: 'Automated and unattended activity',
};

export interface AuditLogRow {
  id: string;
  reference: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actorRole: string;
  module: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  severity: AuditSeverityValue;
  status: AuditStatusValue;
  ipAddress: string | null;
  deviceType: string | null;
  userAgent: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface AuditLogPage {
  rows: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AuditSummary {
  kpis: {
    total: number;
    totalChangePercent: number | null;
    adminActions: number;
    userActions: number;
    criticalEvents: number;
    logins: number;
    failedLogins: number;
    dataChanges: number;
  };
  /** Share of activity by actor kind, for the overview donut. */
  overview: { key: string; label: string; count: number; share: number }[];
  topModules: { module: string; count: number; share: number }[];
  severity: { key: AuditSeverityValue; label: string; count: number; share: number }[];
  /** Daily counts across the selected range. */
  trend: { date: string; count: number }[];
  topActors: { actorId: string | null; name: string; role: string; count: number }[];
  /** Where sign-ins came from, most recent first. */
  loginLocations: { ipAddress: string; deviceType: string | null; count: number; lastSeen: string }[];
  criticalBreakdown: { action: string; count: number }[];
  loginAttempts: { successful: number; failed: number; successRate: number };
  /** Distinct values present in the data, for the filter dropdowns. */
  filters: { modules: string[]; actions: string[]; roles: string[] };
  retention: { retentionDays: number; oldestEntry: string | null; purgeableCount: number };
}

export const auditRetentionSchema = z.object({
  retentionDays: z.number().int().min(30).max(3650),
});
export type AuditRetentionInput = z.infer<typeof auditRetentionSchema>;
