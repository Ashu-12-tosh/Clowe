import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  AUDIT_SEVERITIES,
  AUDIT_SEVERITY_LABELS,
  AUDIT_STATUSES,
  AUDIT_TABS,
  auditRetentionSchema,
  type AuditLogPage,
  type AuditLogRow,
  type AuditSeverityValue,
  type AuditStatusValue,
  type AuditSummary,
  type AuditTab,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { getSettings, setSetting } from '../services/settingsService';
import { auditSafe, deviceFromUserAgent, ipFrom } from '../services/auditService';

export const adminAuditRouter = Router();
adminAuditRouter.use(requireAuth, requireRole('ADMIN'));

const SCAN_CAP = 20000;

const listQuery = z.object({
  tab: z.enum(AUDIT_TABS).default('ALL'),
  q: z.string().trim().max(80).optional(),
  module: z.string().trim().optional(),
  action: z.string().trim().optional(),
  role: z.string().trim().optional(),
  severity: z.enum(['ALL', ...AUDIT_SEVERITIES]).default('ALL'),
  status: z.enum(['ALL', ...AUDIT_STATUSES]).default('ALL'),
  ip: z.string().trim().optional(),
  actorId: z.string().trim().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(10),
});

type Query = z.infer<typeof listQuery>;

/** Each tab is a saved filter, expressed as extra where-clauses. */
function tabWhere(tab: AuditTab): Prisma.AuditLogWhereInput {
  switch (tab) {
    case 'ADMIN':
      return { actorRole: 'ADMIN' };
    case 'LOGIN':
      return { module: 'AUTH' };
    case 'DATA_CHANGE':
      return {
        module: { notIn: ['AUTH'] },
        action: {
          in: [
            'Product created',
            'Product updated',
            'Product archived',
            'Product visibility changed',
            'Stock updated',
            'Store settings changed',
            'Platform settings changed',
            'Try-On settings changed',
            'Promotion created',
            'Promotion updated',
            'Promotion removed',
            'User updated',
          ],
        },
      };
    case 'SECURITY':
      return { OR: [{ status: 'FAILED' }, { severity: { in: ['HIGH', 'CRITICAL'] } }] };
    case 'SYSTEM':
      return { actorRole: { in: ['SYSTEM', 'GUEST'] } };
    default:
      return {};
  }
}

function buildWhere(query: Query): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [tabWhere(query.tab)];

  if (query.module) and.push({ module: query.module });
  if (query.action) and.push({ action: query.action });
  if (query.role) and.push({ actorRole: query.role });
  if (query.severity !== 'ALL') and.push({ severity: query.severity });
  if (query.status !== 'ALL') and.push({ status: query.status });
  if (query.ip) and.push({ ipAddress: { contains: query.ip } });
  if (query.actorId) and.push({ actorId: query.actorId });

  const gte = query.from ? new Date(`${query.from}T00:00:00`) : null;
  const lte = query.to ? new Date(`${query.to}T23:59:59.999`) : null;
  if ((gte && !Number.isNaN(gte.getTime())) || (lte && !Number.isNaN(lte.getTime()))) {
    and.push({
      createdAt: {
        ...(gte && !Number.isNaN(gte.getTime()) ? { gte } : {}),
        ...(lte && !Number.isNaN(lte.getTime()) ? { lte } : {}),
      },
    });
  }

  if (query.q) {
    and.push({
      OR: [
        { reference: { contains: query.q.toUpperCase() } },
        { summary: { contains: query.q, mode: 'insensitive' } },
        { action: { contains: query.q, mode: 'insensitive' } },
        { actorName: { contains: query.q, mode: 'insensitive' } },
        { actorEmail: { contains: query.q, mode: 'insensitive' } },
        { entityId: { contains: query.q } },
      ],
    });
  }

  return { AND: and };
}

type LogRecord = Prisma.AuditLogGetPayload<Record<string, never>>;

function toRow(log: LogRecord): AuditLogRow {
  return {
    id: log.id,
    reference: log.reference,
    actorId: log.actorId,
    actorName: log.actorName,
    actorEmail: log.actorEmail,
    actorRole: log.actorRole,
    module: log.module,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    summary: log.summary,
    metadata: (log.metadata as Record<string, unknown> | null) ?? {},
    severity: log.severity as AuditSeverityValue,
    status: log.status as AuditStatusValue,
    ipAddress: log.ipAddress,
    deviceType: log.deviceType,
    userAgent: log.userAgent,
    durationMs: log.durationMs,
    createdAt: log.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET / — the log table
// ---------------------------------------------------------------------------

adminAuditRouter.get('/', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const where = buildWhere(query);

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    const body: AuditLogPage = {
      rows: logs.map(toRow),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /summary — KPIs, charts and filter options over the same filter
// ---------------------------------------------------------------------------

function changePercent(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const ACTOR_GROUPS: { key: string; label: string; roles: string[] }[] = [
  { key: 'ADMIN', label: 'Admin actions', roles: ['ADMIN'] },
  { key: 'SELLER', label: 'Seller actions', roles: ['SELLER'] },
  { key: 'CUSTOMER', label: 'Customer actions', roles: ['CUSTOMER'] },
  { key: 'SYSTEM', label: 'System events', roles: ['SYSTEM'] },
  { key: 'GUEST', label: 'Anonymous / failed', roles: ['GUEST'] },
];

adminAuditRouter.get('/summary', async (req, res, next) => {
  try {
    const query = listQuery.parse({ ...req.query, tab: 'ALL', page: 1, pageSize: 10 });
    const where = buildWhere(query);
    const settings = await getSettings();

    const now = new Date();
    const rangeStart = query.from ? new Date(`${query.from}T00:00:00`) : null;
    const rangeEnd = query.to ? new Date(`${query.to}T23:59:59.999`) : now;
    const start = rangeStart ?? new Date(now.getTime() - 29 * 86400000);
    const days = Math.max(
      1,
      Math.round((rangeEnd.getTime() - start.getTime()) / 86400000) + 1,
    );
    const previousStart = new Date(start.getTime() - days * 86400000);

    const [logs, previousCount, oldest, retentionCutoffCount] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: SCAN_CAP,
        select: {
          actorId: true,
          actorName: true,
          actorRole: true,
          module: true,
          action: true,
          severity: true,
          status: true,
          ipAddress: true,
          deviceType: true,
          createdAt: true,
        },
      }),
      prisma.auditLog.count({
        where: { createdAt: { gte: previousStart, lt: start } },
      }),
      prisma.auditLog.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      prisma.auditLog.count({
        where: {
          createdAt: {
            lt: new Date(now.getTime() - settings.auditRetentionDays * 86400000),
          },
        },
      }),
    ]);

    const total = logs.length;
    const share = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

    const byRole = new Map<string, number>();
    const byModule = new Map<string, number>();
    const bySeverity = new Map<AuditSeverityValue, number>();
    const byActor = new Map<string, { name: string; role: string; count: number }>();
    const byIp = new Map<string, { deviceType: string | null; count: number; lastSeen: Date }>();
    const criticalActions = new Map<string, number>();
    const trend = new Map<string, number>();

    for (let i = 0; i < Math.min(days, 90); i += 1) {
      const d = new Date(rangeEnd.getTime() - i * 86400000);
      trend.set(dayKey(d), 0);
    }

    for (const log of logs) {
      byRole.set(log.actorRole, (byRole.get(log.actorRole) ?? 0) + 1);
      byModule.set(log.module, (byModule.get(log.module) ?? 0) + 1);
      bySeverity.set(
        log.severity as AuditSeverityValue,
        (bySeverity.get(log.severity as AuditSeverityValue) ?? 0) + 1,
      );

      const actorKey = log.actorId ?? `role:${log.actorRole}`;
      const actor = byActor.get(actorKey) ?? {
        name: log.actorName ?? (log.actorId ? 'Unnamed' : log.actorRole),
        role: log.actorRole,
        count: 0,
      };
      actor.count += 1;
      byActor.set(actorKey, actor);

      if (log.module === 'AUTH' && log.ipAddress) {
        const entry = byIp.get(log.ipAddress) ?? {
          deviceType: log.deviceType,
          count: 0,
          lastSeen: log.createdAt,
        };
        entry.count += 1;
        if (log.createdAt > entry.lastSeen) entry.lastSeen = log.createdAt;
        byIp.set(log.ipAddress, entry);
      }

      if (log.severity === 'CRITICAL') {
        criticalActions.set(log.action, (criticalActions.get(log.action) ?? 0) + 1);
      }

      const key = dayKey(log.createdAt);
      if (trend.has(key)) trend.set(key, (trend.get(key) ?? 0) + 1);
    }

    const logins = logs.filter((l) => l.module === 'AUTH' && l.action.startsWith('Login'));
    const failedLogins = logins.filter((l) => l.status === 'FAILED').length;
    const dataChanges = logs.filter((l) =>
      ['PRODUCTS', 'INVENTORY', 'SETTINGS', 'PROMOTIONS', 'USERS'].includes(l.module),
    ).length;

    const body: AuditSummary = {
      kpis: {
        total,
        totalChangePercent: changePercent(total, previousCount),
        adminActions: byRole.get('ADMIN') ?? 0,
        userActions: (byRole.get('CUSTOMER') ?? 0) + (byRole.get('SELLER') ?? 0),
        criticalEvents: bySeverity.get('CRITICAL') ?? 0,
        logins: logins.length,
        failedLogins,
        dataChanges,
      },
      overview: ACTOR_GROUPS.map((g) => {
        const count = g.roles.reduce((sum, r) => sum + (byRole.get(r) ?? 0), 0);
        return { key: g.key, label: g.label, count, share: share(count) };
      }).filter((g) => g.count > 0),
      topModules: [...byModule.entries()]
        .map(([module, count]) => ({ module, count, share: share(count) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6),
      severity: AUDIT_SEVERITIES.map((key) => ({
        key,
        label: AUDIT_SEVERITY_LABELS[key],
        count: bySeverity.get(key) ?? 0,
        share: share(bySeverity.get(key) ?? 0),
      })).filter((s) => s.count > 0),
      trend: [...trend.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      topActors: [...byActor.entries()]
        .map(([key, v]) => ({
          actorId: key.startsWith('role:') ? null : key,
          name: v.name,
          role: v.role,
          count: v.count,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      loginLocations: [...byIp.entries()]
        .map(([ipAddress, v]) => ({
          ipAddress,
          deviceType: v.deviceType,
          count: v.count,
          lastSeen: v.lastSeen.toISOString(),
        }))
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
        .slice(0, 5),
      criticalBreakdown: [...criticalActions.entries()]
        .map(([action, count]) => ({ action, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 4),
      loginAttempts: {
        successful: logins.length - failedLogins,
        failed: failedLogins,
        successRate:
          logins.length > 0
            ? Math.round(((logins.length - failedLogins) / logins.length) * 1000) / 10
            : 100,
      },
      filters: {
        modules: [...byModule.keys()].sort(),
        actions: [...new Set(logs.map((l) => l.action))].sort().slice(0, 60),
        roles: [...byRole.keys()].sort(),
      },
      retention: {
        retentionDays: settings.auditRetentionDays,
        oldestEntry: oldest?.createdAt.toISOString() ?? null,
        purgeableCount: retentionCutoffCount,
      },
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Retention policy
// ---------------------------------------------------------------------------

adminAuditRouter.put('/retention', async (req, res, next) => {
  try {
    const input = auditRetentionSchema.parse(req.body);
    await setSetting('auditRetentionDays', input.retentionDays);
    auditSafe({
      actorId: req.auth!.userId,
      actorRole: 'ADMIN',
      module: 'SETTINGS',
      action: 'Audit retention changed',
      summary: `Audit log retention set to ${input.retentionDays} days`,
      severity: 'CRITICAL',
      ipAddress: ipFrom(req),
      userAgent: req.get('user-agent') ?? null,
      deviceType: deviceFromUserAgent(req.get('user-agent')),
      metadata: { retentionDays: input.retentionDays },
    });
    res.json({ success: true, data: { retentionDays: input.retentionDays } });
  } catch (err) {
    next(err);
  }
});

/** Delete entries older than the retention window. Itself audited. */
adminAuditRouter.post('/purge', async (req, res, next) => {
  try {
    const settings = await getSettings();
    const cutoff = new Date(Date.now() - settings.auditRetentionDays * 86400000);
    const { count } = await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });

    auditSafe({
      actorId: req.auth!.userId,
      actorRole: 'ADMIN',
      module: 'SETTINGS',
      action: 'Audit logs purged',
      summary: `Purged ${count} audit entries older than ${settings.auditRetentionDays} days`,
      severity: 'CRITICAL',
      ipAddress: ipFrom(req),
      userAgent: req.get('user-agent') ?? null,
      deviceType: deviceFromUserAgent(req.get('user-agent')),
      metadata: { purged: count, cutoff: cutoff.toISOString() },
    });
    res.json({ success: true, data: { purged: count, cutoff: cutoff.toISOString() } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /export — the filtered log as CSV
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

adminAuditRouter.get('/export', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const logs = await prisma.auditLog.findMany({
      where: buildWhere(query),
      orderBy: { createdAt: 'desc' },
      take: SCAN_CAP,
    });

    const header = [
      'Log ID',
      'Timestamp',
      'Actor',
      'Email',
      'Role',
      'Module',
      'Action',
      'Details',
      'Entity',
      'Severity',
      'Status',
      'IP address',
      'Device',
      'Duration (ms)',
    ];
    const lines = [header.join(',')];
    for (const log of logs) {
      lines.push(
        [
          log.reference,
          log.createdAt.toISOString(),
          log.actorName ?? '',
          log.actorEmail ?? '',
          log.actorRole,
          log.module,
          log.action,
          log.summary,
          log.entityId ?? '',
          log.severity,
          log.status,
          log.ipAddress ?? '',
          log.deviceType ?? '',
          log.durationMs ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }

    // Exporting the audit trail is itself an auditable act.
    auditSafe({
      actorId: req.auth!.userId,
      actorRole: 'ADMIN',
      module: 'SETTINGS',
      action: 'Audit log exported',
      summary: `Exported ${logs.length} audit entries`,
      severity: 'HIGH',
      ipAddress: ipFrom(req),
      userAgent: req.get('user-agent') ?? null,
      deviceType: deviceFromUserAgent(req.get('user-agent')),
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clowe-audit-log.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:id — one entry in full
// ---------------------------------------------------------------------------

adminAuditRouter.get('/:id', async (req, res, next) => {
  try {
    const log = await prisma.auditLog.findUnique({ where: { id: req.params.id } });
    if (!log) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Log not found' } });
      return;
    }
    res.json({ success: true, data: toRow(log) });
  } catch (err) {
    next(err);
  }
});
