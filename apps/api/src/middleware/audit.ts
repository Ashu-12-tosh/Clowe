import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../db';
import {
  auditSafe,
  deviceFromUserAgent,
  ipFrom,
  type AuditSeverity,
} from '../services/auditService';

// ---------------------------------------------------------------------------
// Automatic audit capture.
//
// Every state-changing API call is recorded once the response finishes, so a
// new endpoint is covered the moment it ships. Known routes get a readable
// action name and a considered severity; anything else still lands in the log
// with its method and path.
// ---------------------------------------------------------------------------

interface RouteRule {
  method: string;
  /** Matched against the path with :params collapsed to '*'. */
  pattern: RegExp;
  module: string;
  action: string;
  severity?: AuditSeverity;
  entityType?: string;
}

/** Path with record ids collapsed to a star, so one rule matches every id. */
function normalise(path: string): string {
  return path
    .split('/')
    .map((seg) => (/^[a-z0-9]{20,}$/i.test(seg) ? '*' : seg))
    .join('/');
}

const RULES: RouteRule[] = [
  // --- Authentication & account -------------------------------------------
  { method: 'POST', pattern: /^\/api\/auth\/logout/, module: 'AUTH', action: 'Logout' },
  { method: 'POST', pattern: /^\/api\/auth\/logout-all/, module: 'AUTH', action: 'Logout all devices', severity: 'MEDIUM' },
  { method: 'POST', pattern: /^\/api\/auth\/me\/set-pin/, module: 'AUTH', action: 'PIN changed', severity: 'MEDIUM' },
  { method: 'POST', pattern: /^\/api\/auth\/me\/change-phone/, module: 'AUTH', action: 'Phone change requested', severity: 'HIGH' },
  { method: 'POST', pattern: /^\/api\/auth\/register/, module: 'AUTH', action: 'Account created' },

  // --- Admin moderation ---------------------------------------------------
  { method: 'PATCH', pattern: /^\/api\/admin\/sellers\/\*\/status/, module: 'SELLERS', action: 'Seller status changed', severity: 'CRITICAL', entityType: 'SellerProfile' },
  { method: 'PATCH', pattern: /^\/api\/admin\/sellers\/\*\/kyc/, module: 'SELLERS', action: 'KYC decision', severity: 'HIGH', entityType: 'SellerProfile' },
  { method: 'POST', pattern: /^\/api\/admin\/sellers\/\*\/notes/, module: 'SELLERS', action: 'Internal note added', entityType: 'SellerProfile' },
  { method: 'PATCH', pattern: /^\/api\/admin\/products\//, module: 'PRODUCTS', action: 'Product moderated', severity: 'HIGH', entityType: 'Product' },
  { method: 'PATCH', pattern: /^\/api\/admin\/returns\/\*\/override/, module: 'RETURNS', action: 'Return overridden by admin', severity: 'HIGH', entityType: 'Return' },
  { method: 'PATCH', pattern: /^\/api\/admin\/complaints\//, module: 'SUPPORT', action: 'Complaint updated', severity: 'MEDIUM' },
  { method: 'PATCH', pattern: /^\/api\/admin\/ads\//, module: 'ADS', action: 'Ad moderated', severity: 'MEDIUM' },
  { method: 'PUT', pattern: /^\/api\/admin\/settings/, module: 'SETTINGS', action: 'Platform settings changed', severity: 'CRITICAL' },
  { method: 'PUT', pattern: /^\/api\/admin\/tryon\/settings/, module: 'SETTINGS', action: 'Try-On settings changed', severity: 'HIGH' },
  { method: 'POST', pattern: /^\/api\/admin\/tryon\/requests\/\*\/flag/, module: 'AI_TRYON', action: 'Try-on flagged', severity: 'MEDIUM' },
  { method: 'DELETE', pattern: /^\/api\/admin\/tryon\/requests\/\*\/result/, module: 'AI_TRYON', action: 'Try-on result removed', severity: 'HIGH' },
  { method: 'POST', pattern: /^\/api\/admin\/support\/\*\/reply/, module: 'SUPPORT', action: 'Support replied' },
  { method: 'PATCH', pattern: /^\/api\/admin\/support\//, module: 'SUPPORT', action: 'Ticket updated' },
  { method: 'PATCH', pattern: /^\/api\/admin\/seller-referrals\/\*\/void/, module: 'SELLERS', action: 'Referral voided', severity: 'HIGH' },
  { method: 'PATCH', pattern: /^\/api\/admin\/users\//, module: 'USERS', action: 'User updated', severity: 'HIGH', entityType: 'User' },

  // --- Seller actions ------------------------------------------------------
  { method: 'POST', pattern: /^\/api\/seller\/products$/, module: 'PRODUCTS', action: 'Product created', entityType: 'Product' },
  { method: 'PUT', pattern: /^\/api\/seller\/products\//, module: 'PRODUCTS', action: 'Product updated', severity: 'MEDIUM', entityType: 'Product' },
  { method: 'DELETE', pattern: /^\/api\/seller\/products\//, module: 'PRODUCTS', action: 'Product archived', severity: 'HIGH', entityType: 'Product' },
  { method: 'PATCH', pattern: /^\/api\/seller\/products\/\*\/visibility/, module: 'PRODUCTS', action: 'Product visibility changed', severity: 'MEDIUM', entityType: 'Product' },
  { method: 'PATCH', pattern: /^\/api\/seller\/inventory\/stock/, module: 'INVENTORY', action: 'Stock updated', severity: 'MEDIUM' },
  { method: 'PATCH', pattern: /^\/api\/seller\/orders\/\*\/status/, module: 'ORDERS', action: 'Order line updated', entityType: 'OrderItem' },
  { method: 'POST', pattern: /^\/api\/seller\/orders\/bulk/, module: 'ORDERS', action: 'Bulk order update', severity: 'MEDIUM' },
  { method: 'PATCH', pattern: /^\/api\/seller\/returns\//, module: 'RETURNS', action: 'Return decision', severity: 'MEDIUM', entityType: 'Return' },
  { method: 'POST', pattern: /^\/api\/seller\/returns\/bulk/, module: 'RETURNS', action: 'Bulk return decision', severity: 'MEDIUM' },
  { method: 'POST', pattern: /^\/api\/seller\/payouts\/request/, module: 'PAYOUTS', action: 'Payout requested', severity: 'HIGH' },
  { method: 'POST', pattern: /^\/api\/seller\/payouts\/methods/, module: 'PAYOUTS', action: 'Payout method added', severity: 'HIGH' },
  { method: 'DELETE', pattern: /^\/api\/seller\/payouts\/methods\//, module: 'PAYOUTS', action: 'Payout method removed', severity: 'HIGH' },
  { method: 'POST', pattern: /^\/api\/seller\/promotions$/, module: 'PROMOTIONS', action: 'Promotion created', severity: 'MEDIUM' },
  { method: 'PUT', pattern: /^\/api\/seller\/promotions\//, module: 'PROMOTIONS', action: 'Promotion updated', severity: 'MEDIUM' },
  { method: 'PATCH', pattern: /^\/api\/seller\/promotions\/\*\/state/, module: 'PROMOTIONS', action: 'Promotion state changed', severity: 'MEDIUM' },
  { method: 'DELETE', pattern: /^\/api\/seller\/promotions\//, module: 'PROMOTIONS', action: 'Promotion removed', severity: 'MEDIUM' },
  { method: 'PUT', pattern: /^\/api\/seller\/store\//, module: 'SETTINGS', action: 'Store settings changed', severity: 'MEDIUM' },
  { method: 'POST', pattern: /^\/api\/seller\/support\/tickets$/, module: 'SUPPORT', action: 'Ticket raised' },
  { method: 'POST', pattern: /^\/api\/seller\/register/, module: 'SELLERS', action: 'Seller registered', severity: 'MEDIUM' },
  { method: 'POST', pattern: /^\/api\/seller\/ads$/, module: 'ADS', action: 'Ad booked', severity: 'MEDIUM' },

  // --- Customer & money ----------------------------------------------------
  { method: 'POST', pattern: /^\/api\/orders\/checkout/, module: 'ORDERS', action: 'Order placed', severity: 'MEDIUM', entityType: 'Order' },
  { method: 'POST', pattern: /^\/api\/orders\/\*\/cancel/, module: 'ORDERS', action: 'Order cancelled', severity: 'HIGH', entityType: 'Order' },
  { method: 'POST', pattern: /^\/api\/orders\/items\/\*\/return/, module: 'RETURNS', action: 'Return requested', severity: 'MEDIUM' },
  { method: 'POST', pattern: /^\/api\/payments\//, module: 'PAYMENTS', action: 'Payment event', severity: 'HIGH' },
  { method: 'POST', pattern: /^\/api\/credits\//, module: 'PAYMENTS', action: 'Credits purchase', severity: 'MEDIUM' },
  { method: 'POST', pattern: /^\/api\/tryon$/, module: 'AI_TRYON', action: 'Try-on generated' },
];

/**
 * Paths that change state but say nothing worth auditing — high-volume
 * shopping noise that would bury the events an admin is actually looking for.
 */
const IGNORED = [
  // Recorded explicitly by auditLogin with the right severity.
  /^\/api\/auth\/verify-otp/,
  /^\/api\/auth\/pin-login/,
  /^\/api\/cart/,
  /^\/api\/wishlist/,
  /^\/api\/auth\/refresh/,
  /^\/api\/auth\/request-otp/,
  /^\/api\/ai\//,
  /^\/api\/notifications/,
  /^\/api\/track/,
  /^\/api\/uploads/,
];

function matchRule(method: string, path: string): RouteRule | null {
  const normalised = normalise(path);
  return (
    RULES.find((r) => r.method === method && r.pattern.test(normalised)) ??
    RULES.find((r) => r.method === method && r.pattern.test(path)) ??
    null
  );
}

/** Module guessed from the path when no rule matches. */
function fallbackModule(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const segment = parts[1] === 'admin' || parts[1] === 'seller' ? parts[2] : parts[1];
  return (segment ?? 'API').toUpperCase().replace(/[^A-Z_]/g, '');
}

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function auditLogger(req: Request, res: Response, next: NextFunction): void {
  // Only API traffic is auditable; static uploads are not.
  if (
    !req.path.startsWith('/api/') ||
    !MUTATIONS.has(req.method) ||
    IGNORED.some((p) => p.test(req.path))
  ) {
    next();
    return;
  }

  const startedAt = Date.now();
  const { method, originalUrl } = req;
  const path = req.path;

  res.on('finish', () => {
    // 401s on an expired token are noise; a real failure is 400/403/409/5xx.
    if (res.statusCode === 401) return;

    const rule = matchRule(method, path);
    const failed = res.statusCode >= 400;
    // A failed attempt at a sensitive action is more interesting, not less.
    const severity: AuditSeverity = failed
      ? rule?.severity === 'CRITICAL'
        ? 'CRITICAL'
        : 'HIGH'
      : (rule?.severity ?? 'LOW');

    const actorRole = req.auth?.role ?? 'GUEST';
    const action = rule?.action ?? `${method} ${path.replace(/^\/api\//, '')}`;

    // The actor's display name is fetched lazily so the request isn't blocked.
    void (async () => {
      let actorName: string | null = null;
      let actorEmail: string | null = null;
      if (req.auth?.userId) {
        const user = await prisma.user
          .findUnique({ where: { id: req.auth.userId }, select: { name: true, email: true } })
          .catch(() => null);
        actorName = user?.name ?? null;
        actorEmail = user?.email ?? null;
      }

      auditSafe({
        actorId: req.auth?.userId ?? null,
        actorName,
        actorEmail,
        actorRole,
        module: rule?.module ?? fallbackModule(path),
        action,
        entityType: rule?.entityType ?? null,
        // Last path segment is the record id on REST-shaped routes.
        entityId: path.split('/').filter(Boolean).find((s) => /^[a-z0-9]{20,}$/i.test(s)) ?? null,
        summary: failed
          ? `${action} failed (HTTP ${res.statusCode})`
          : `${action} via ${method} ${path}`,
        metadata: { method, path: originalUrl, statusCode: res.statusCode },
        severity,
        status: failed ? 'FAILED' : 'SUCCESS',
        ipAddress: ipFrom(req),
        userAgent: req.get('user-agent') ?? null,
        deviceType: deviceFromUserAgent(req.get('user-agent')),
        durationMs: Date.now() - startedAt,
      });
    })();
  });

  next();
}
