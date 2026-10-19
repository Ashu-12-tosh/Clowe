import { Router, type Request } from 'express';
import { payoutRejectSchema, type AdminPayoutRow, type PayoutStatusValue } from '@clowe/shared';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { deviceFromUserAgent, ipFrom, recordAudit } from '../services/auditService';
import { approvePayout, rejectPayout, syncPayout } from '../services/payoutService';
import { ApiError } from '../utils/ApiError';

/**
 * Payout approvals. Every payout a seller requests waits here (PENDING) until
 * an admin approves it — then it is sent — or rejects it, which puts the
 * amount back in the seller's balance. Each decision is in the audit log.
 * Turned off with the payoutAutoApprove setting once payouts can go
 * unattended.
 */
export const adminPayoutsRouter = Router();
adminPayoutsRouter.use(requireAuth, requireRole('ADMIN'));

const ROW_INCLUDE = {
  seller: { select: { id: true, shopName: true } },
  reviewedBy: { select: { name: true, phone: true } },
  _count: { select: { items: true } },
} as const;
type Row = Prisma.PayoutGetPayload<{ include: typeof ROW_INCLUDE }>;

function toRow(p: Row): AdminPayoutRow {
  return {
    id: p.id,
    reference: p.reference,
    sellerId: p.seller.id,
    shopName: p.seller.shopName,
    netPaise: p.netPaise,
    grossPaise: p.grossPaise,
    feesPaise: p.commissionPaise + p.gatewayPaise + p.otherFeesPaise,
    tdsPaise: p.tdsPaise,
    tcsPaise: p.tcsPaise,
    adjustmentPaise: p.adjustmentPaise,
    itemCount: p._count.items,
    methodLabel: p.methodLabel,
    status: p.status as PayoutStatusValue,
    requestedAt: p.requestedAt.toISOString(),
    reviewedAt: p.reviewedAt?.toISOString() ?? null,
    reviewedBy: p.reviewedBy ? (p.reviewedBy.name ?? p.reviewedBy.phone) : null,
    rejectionReason: p.rejectionReason,
    failureReason: p.failureReason,
    utr: p.utr,
    providerStatus: p.providerStatus,
    processedAt: p.processedAt?.toISOString() ?? null,
  };
}

/** Written before the response: a payout decision is never left unrecorded. */
function audit(req: Request, action: string, p: { id: string; reference: string; netPaise: number; seller: { shopName: string } }, extra: Record<string, unknown> = {}, severity: 'HIGH' | 'CRITICAL' = 'HIGH') {
  return recordAudit({
    actorId: req.auth!.userId,
    actorRole: 'ADMIN',
    module: 'PAYOUTS',
    action,
    entityType: 'Payout',
    entityId: p.id,
    summary: `${action}: ${p.reference} — ₹${(p.netPaise / 100).toFixed(2)} to ${p.seller.shopName}${extra.reason ? ` (${String(extra.reason)})` : ''}`,
    metadata: { reference: p.reference, netPaise: p.netPaise, ...extra },
    severity,
    ipAddress: ipFrom(req),
    userAgent: req.get('user-agent') ?? null,
    deviceType: deviceFromUserAgent(req.get('user-agent')),
  });
}

const STATUSES: PayoutStatusValue[] = ['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED', 'REVERSED'];

// GET /api/admin/payouts?status=PENDING — oldest first while waiting, newest first otherwise.
adminPayoutsRouter.get('/', async (req, res, next) => {
  try {
    const status = STATUSES.includes(req.query.status as PayoutStatusValue) ? (req.query.status as PayoutStatusValue) : 'PENDING';
    const rows = await prisma.payout.findMany({
      where: { status },
      include: ROW_INCLUDE,
      orderBy: { requestedAt: status === 'PENDING' || status === 'PROCESSING' ? 'asc' : 'desc' },
      take: 200,
    });
    const counts = await prisma.payout.groupBy({ by: ['status'], _count: { _all: true } });
    res.json({
      success: true,
      data: {
        rows: rows.map(toRow),
        counts: Object.fromEntries(STATUSES.map((s) => [s, counts.find((c) => c.status === s)?._count._all ?? 0])),
      },
    });
  } catch (err) {
    next(err);
  }
});

async function load(id: string) {
  const p = await prisma.payout.findUnique({ where: { id }, include: ROW_INCLUDE });
  if (!p) throw ApiError.notFound('Payout not found');
  return p;
}

// POST /api/admin/payouts/:id/approve — send it now.
adminPayoutsRouter.post('/:id/approve', async (req, res, next) => {
  try {
    const before = await load(req.params.id);
    await approvePayout(before.id, req.auth!.userId);
    const after = await load(before.id);
    await audit(req, 'Payout approved', after, { status: after.status, utr: after.utr, failureReason: after.failureReason }, 'CRITICAL');
    res.json({ success: true, data: toRow(after) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/payouts/:id/reject { reason } — nothing is sent; the amount goes back to the seller's balance.
adminPayoutsRouter.post('/:id/reject', async (req, res, next) => {
  try {
    const { reason } = payoutRejectSchema.parse(req.body);
    const before = await load(req.params.id);
    await rejectPayout(before.id, req.auth!.userId, reason);
    const after = await load(before.id);
    await audit(req, 'Payout rejected', after, { reason });
    res.json({ success: true, data: toRow(after) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/payouts/:id/check — ask the provider about a transfer now.
adminPayoutsRouter.post('/:id/check', async (req, res, next) => {
  try {
    const before = await load(req.params.id);
    await syncPayout(before.id);
    const after = await load(before.id);
    if (after.status !== before.status) await audit(req, 'Payout status checked', after, { from: before.status, to: after.status });
    res.json({ success: true, data: toRow(after) });
  } catch (err) {
    next(err);
  }
});
