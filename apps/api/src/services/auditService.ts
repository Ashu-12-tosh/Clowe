import type { Request } from 'express';
import { prisma } from '../db';

// ---------------------------------------------------------------------------
// Audit trail.
//
// Every state-changing request is captured by the audit middleware; security
// events (logins, lockouts) are recorded explicitly so they carry the right
// severity even when the HTTP status looks ordinary.
// ---------------------------------------------------------------------------

export type AuditSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type AuditStatus = 'SUCCESS' | 'FAILED';

export interface AuditInput {
  actorId?: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  actorRole: string;
  module: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
  severity?: AuditSeverity;
  status?: AuditStatus;
  ipAddress?: string | null;
  userAgent?: string | null;
  deviceType?: string | null;
  durationMs?: number | null;
}

/** LOG-YYYYMMDD-XXXXXX, unique and sortable by eye. */
function reference(now: Date, sequence: number): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `LOG-${y}${m}${d}-${String(sequence).padStart(6, '0')}`;
}

/** Coarse device bucket from the User-Agent. */
export function deviceFromUserAgent(ua: string | undefined): string {
  if (!ua) return 'OTHER';
  const s = ua.toLowerCase();
  if (/ipad|tablet|playbook|silk|android(?!.*mobile)/.test(s)) return 'TABLET';
  if (/mobi|iphone|ipod|android|blackberry|windows phone/.test(s)) return 'MOBILE';
  if (/curl|wget|postman|node|axios/.test(s)) return 'API';
  if (/windows|macintosh|mac os x|linux|cros/.test(s)) return 'DESKTOP';
  return 'OTHER';
}

/** The client IP, honouring the proxy header the app already trusts. */
export function ipFrom(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return req.ip ?? null;
}

/**
 * Write one audit row. Never throws — an audit failure must not break the
 * request that triggered it.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const data = {
    actorId: input.actorId ?? null,
    actorName: input.actorName ?? null,
    actorEmail: input.actorEmail ?? null,
    actorRole: input.actorRole,
    module: input.module,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    summary: input.summary,
    metadata: (input.metadata ?? {}) as object,
    severity: input.severity ?? 'LOW',
    status: input.status ?? 'SUCCESS',
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent?.slice(0, 300) ?? null,
    deviceType: input.deviceType ?? null,
    durationMs: input.durationMs ?? null,
  } as const;

  // References are sequential per day. Two writes in the same tick read the
  // same count, so a unique-violation just takes the next number.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const todayCount = await prisma.auditLog.count({ where: { createdAt: { gte: startOfDay } } });
      await prisma.auditLog.create({
        data: { ...data, reference: reference(now, todayCount + 1 + attempt) },
      });
      return;
    } catch (err) {
      const isDuplicate =
        typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
      if (!isDuplicate) {
        // An audit failure must never break the request that triggered it.
        console.error('[clowe-api] audit write failed:', err);
        return;
      }
    }
  }
  console.error('[clowe-api] audit write gave up after 5 reference collisions');
}

/** Fire-and-forget wrapper for call sites that must not await the write. */
export function auditSafe(input: AuditInput): void {
  void recordAudit(input);
}

/** Record a login attempt with the severity a security log expects. */
export function auditLogin(
  req: Request,
  outcome: 'SUCCESS' | 'FAILED',
  detail: { userId?: string | null; name?: string | null; role?: string; phone: string; reason?: string },
): void {
  auditSafe({
    actorId: detail.userId ?? null,
    actorName: detail.name ?? null,
    actorRole: detail.role ?? (outcome === 'SUCCESS' ? 'CUSTOMER' : 'GUEST'),
    module: 'AUTH',
    action: outcome === 'SUCCESS' ? 'Login success' : 'Login failed',
    entityType: 'User',
    entityId: detail.userId ?? null,
    summary:
      outcome === 'SUCCESS'
        ? `Signed in as +91 ${detail.phone}`
        : `Failed sign-in for +91 ${detail.phone}${detail.reason ? ` — ${detail.reason}` : ''}`,
    // Failed sign-ins are the signal a security review actually looks for.
    severity: outcome === 'SUCCESS' ? 'LOW' : 'HIGH',
    status: outcome,
    ipAddress: ipFrom(req),
    userAgent: req.get('user-agent') ?? null,
    deviceType: deviceFromUserAgent(req.get('user-agent')),
    metadata: { phone: detail.phone, ...(detail.reason ? { reason: detail.reason } : {}) },
  });
}
