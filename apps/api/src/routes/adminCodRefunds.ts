import { Router, type Request } from 'express';
import { codRefundPaidSchema, maskLast4, type CodRefundAccountView, type CodRefundRow } from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { auditSafe, deviceFromUserAgent, ipFrom } from '../services/auditService';
import { decryptCodRefundAccount } from '../services/codRefundCrypto';
import { completeCodRefund, MANUAL_COD_PROVIDER } from '../services/refundService';
import { ApiError } from '../utils/ApiError';

/**
 * Cash on Delivery refunds to pay. Each is a bank transfer an admin makes by
 * hand to the account the buyer gave with their return; the list shows the
 * account masked, the full details come only on request (and every request is
 * logged), and "Mark refunded" records the bank's reference and tells the
 * buyer. Sellers have no route to any of it.
 */
export const adminCodRefundsRouter = Router();
adminCodRefundsRouter.use(requireAuth, requireRole('ADMIN'));

const ROW_INCLUDE = {
  order: { select: { id: true, orderNumber: true, user: { select: { name: true, phone: true } } } },
  return: {
    select: {
      id: true,
      rmaNumber: true,
      orderItem: { select: { title: true } },
      codRefundAccount: { select: { last4: true } },
    },
  },
} as const;

function audit(req: Request, action: string, refundId: string, summary: string, metadata: Record<string, unknown>) {
  auditSafe({
    actorId: req.auth!.userId,
    actorRole: 'ADMIN',
    module: 'RETURNS',
    action,
    entityType: 'Refund',
    entityId: refundId,
    summary,
    metadata,
    severity: 'HIGH',
    ipAddress: ipFrom(req),
    userAgent: req.get('user-agent') ?? null,
    deviceType: deviceFromUserAgent(req.get('user-agent')),
  });
}

// GET /api/admin/cod-refunds?status=PENDING|PROCESSED — newest first.
adminCodRefundsRouter.get('/', async (req, res, next) => {
  try {
    const status = req.query.status === 'PROCESSED' ? 'PROCESSED' : 'PENDING';
    const refunds = await prisma.refund.findMany({
      where: { provider: MANUAL_COD_PROVIDER, status },
      include: ROW_INCLUDE,
      orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' },
      take: 200,
    });
    const rows: CodRefundRow[] = refunds.map((r) => ({
      refundId: r.id,
      returnId: r.return?.id ?? null,
      rmaNumber: r.return?.rmaNumber ?? null,
      orderId: r.order.id,
      orderNumber: r.order.orderNumber,
      buyerName: r.order.user.name,
      buyerPhone: r.order.user.phone,
      itemTitle: r.return?.orderItem.title ?? null,
      amountPaise: r.amountPaise,
      status: r.status,
      // Only the last four digits are kept readable; the rest is never stored in the clear.
      accountMasked: r.return?.codRefundAccount ? maskLast4(`00000000${r.return.codRefundAccount.last4}`) : null,
      createdAt: r.createdAt.toISOString(),
      paidAt: r.processedAt?.toISOString() ?? null,
      reference: r.status === 'PROCESSED' ? r.providerRefundId : null,
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/cod-refunds/:id/reveal — the full account, to make the transfer. Logged every time.
adminCodRefundsRouter.post('/:id/reveal', async (req, res, next) => {
  try {
    const refund = await prisma.refund.findUnique({
      where: { id: req.params.id },
      include: { order: { select: { orderNumber: true } }, return: { select: { codRefundAccount: true } } },
    });
    if (!refund || refund.provider !== MANUAL_COD_PROVIDER) throw ApiError.notFound('COD refund not found');
    const stored = refund.return?.codRefundAccount;
    if (!stored) throw ApiError.badRequest('The buyer gave no bank account for this refund', 'NO_ACCOUNT');
    const account: CodRefundAccountView = decryptCodRefundAccount(stored.cipher);
    audit(req, 'COD refund account viewed', refund.id, `Viewed the bank account for the COD refund on ${refund.order.orderNumber} (ending ${stored.last4})`, {
      orderNumber: refund.order.orderNumber,
      last4: stored.last4,
    });
    res.json({ success: true, data: account });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/cod-refunds/:id/mark-refunded { reference } — the transfer is done.
adminCodRefundsRouter.post('/:id/mark-refunded', async (req, res, next) => {
  try {
    const { reference } = codRefundPaidSchema.parse(req.body);
    let refund;
    try {
      refund = await completeCodRefund(req.params.id, reference);
    } catch (err) {
      const reason = err instanceof Error ? err.message : '';
      if (reason === 'NOT_A_COD_REFUND') throw ApiError.notFound('COD refund not found');
      if (reason === 'ALREADY_SETTLED') throw ApiError.badRequest('This refund is already marked refunded', 'ALREADY_REFUNDED');
      throw err;
    }
    audit(req, 'COD refund marked paid', refund.id, `Marked the COD refund of ₹${(refund.amountPaise / 100).toFixed(2)} on ${refund.order.orderNumber} paid (reference ${reference})`, {
      orderNumber: refund.order.orderNumber,
      amountPaise: refund.amountPaise,
      reference,
      last4: refund.return?.codRefundAccount?.last4 ?? null,
    });
    res.json({ success: true, data: { refundId: refund.id, status: 'PROCESSED', reference } });
  } catch (err) {
    next(err);
  }
});
