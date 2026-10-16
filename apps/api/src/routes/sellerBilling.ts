import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { invoiceFor, invoiceList } from '../services/sellerInvoice';
import { walletView } from '../services/wallet';
import { requireSeller } from './seller';

// ---------------------------------------------------------------------------
// A seller's billing with Clowe (owner's Batch 2): the Seller Wallet (topped
// up through /api/seller/promotion-credits/purchase), advertising credit, and
// Clowe's monthly tax invoices.
// ---------------------------------------------------------------------------

export const sellerBillingRouter = Router();
sellerBillingRouter.use(requireAuth, requireSeller);

sellerBillingRouter.get('/wallet', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const recent = await prisma.sellerLedgerEntry.findMany({
      where: { sellerId, bucket: { in: ['PROMOTION', 'AD_CREDIT'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, type: true, bucket: true, amountPaise: true, note: true, createdAt: true },
    });
    res.json({
      success: true,
      data: { ...(await walletView(sellerId)), recent: recent.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) },
    });
  } catch (err) {
    next(err);
  }
});

sellerBillingRouter.get('/invoices', async (req, res, next) => {
  try {
    res.json({ success: true, data: await invoiceList(req.seller!.id) });
  } catch (err) {
    next(err);
  }
});

sellerBillingRouter.get('/invoices/:month', async (req, res, next) => {
  try {
    res.json({ success: true, data: await invoiceFor(req.seller!.id, req.params.month) });
  } catch (err) {
    next(err);
  }
});
