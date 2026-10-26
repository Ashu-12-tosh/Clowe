import { Router } from 'express';
import {
  DELHIVERY_BILLING_STATUSES,
  delhiveryBillingAdjustSchema,
  delhiveryBillingColumnsSchema,
  delhiveryBillingUploadSchema,
  type DelhiveryBillingStatus,
} from '@clowe/shared';
import { requireAuth, requireRole } from '../middleware/auth';
import { auditSafe, ipFrom } from '../services/auditService';
import {
  adjustBillingLine,
  billingCheckView,
  billingColumnsView,
  createBillingCheck,
  listBillingChecks,
  saveBillingColumns,
} from '../services/shipping/billingCheck';

// Delhivery billing check: the month's billing export matched to what sellers
// were charged for the same parcels. Nothing here posts on its own; an admin
// confirms each adjustment.
export const adminDelhiveryBillingRouter = Router();
adminDelhiveryBillingRouter.use(requireAuth, requireRole('ADMIN'));

adminDelhiveryBillingRouter.get('/columns', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await billingColumnsView() });
  } catch (err) {
    next(err);
  }
});

adminDelhiveryBillingRouter.put('/columns', async (req, res, next) => {
  try {
    const columns = await saveBillingColumns(delhiveryBillingColumnsSchema.parse(req.body));
    res.json({ success: true, data: columns });
  } catch (err) {
    next(err);
  }
});

adminDelhiveryBillingRouter.get('/checks', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await listBillingChecks() });
  } catch (err) {
    next(err);
  }
});

adminDelhiveryBillingRouter.post('/checks', async (req, res, next) => {
  try {
    const input = delhiveryBillingUploadSchema.parse(req.body);
    res.json({ success: true, data: await createBillingCheck(input, req.auth!.userId) });
  } catch (err) {
    next(err);
  }
});

adminDelhiveryBillingRouter.get('/checks/:id', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' && (DELHIVERY_BILLING_STATUSES as readonly string[]).includes(req.query.status)
      ? (req.query.status as DelhiveryBillingStatus)
      : undefined;
    const sellerId = typeof req.query.sellerId === 'string' && req.query.sellerId ? req.query.sellerId : undefined;
    res.json({ success: true, data: await billingCheckView(req.params.id, { status, sellerId }) });
  } catch (err) {
    next(err);
  }
});

// Post one line's difference to its seller's ledger, on the admin's confirmation.
adminDelhiveryBillingRouter.post('/lines/:id/adjust', async (req, res, next) => {
  try {
    delhiveryBillingAdjustSchema.parse(req.body);
    const { line, entryId, month } = await adjustBillingLine(req.params.id, req.auth!.userId);
    const direction = line.differencePaise > 0 ? 'charged' : 'credited';
    auditSafe({
      actorId: req.auth!.userId,
      actorRole: 'ADMIN',
      module: 'PAYOUTS',
      action: 'Delhivery billing adjustment',
      entityType: 'SellerLedgerEntry',
      entityId: entryId,
      summary: `${line.shopName ?? 'Seller'} ${direction} Rs ${(Math.abs(line.differencePaise) / 100).toLocaleString('en-IN')} — Delhivery billing check ${month}, AWB ${line.awbNumber} (${line.kind})`,
      metadata: {
        sellerId: line.sellerId,
        billingLineId: line.id,
        shipmentId: line.shipmentId,
        billedPaise: line.billedPaise,
        ledgerPaise: line.ledgerPaise,
        differencePaise: line.differencePaise,
      },
      ipAddress: ipFrom(req),
    });
    res.json({ success: true, data: line });
  } catch (err) {
    next(err);
  }
});
