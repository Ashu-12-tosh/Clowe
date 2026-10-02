import { Router } from 'express';
import { sellerLedgerQuerySchema } from '@clowe/shared';
import { requireAuth } from '../middleware/auth';
import { history, penaltiesView } from '../services/sellerLedgerService';
import { blockSuspendedWrites, requireSeller } from './seller';

export const sellerLedgerRouter = Router();
sellerLedgerRouter.use(requireAuth, requireSeller, blockSuspendedWrites);

// Late-dispatch penalties with their waivers and the rule that charges them.
// Answers with the rule and empty rows when there has never been a penalty,
// so the payouts page can always explain it.
sellerLedgerRouter.get('/penalties', async (req, res, next) => {
  try {
    res.json({ success: true, data: await penaltiesView(req.seller!.id) });
  } catch (err) {
    next(err);
  }
});

// The seller's money, one row per event, newest first, with the balance after
// each. ?bucket=SETTLEMENT (payable money) or PROMOTION (ad credits).
sellerLedgerRouter.get('/', async (req, res, next) => {
  try {
    const query = sellerLedgerQuerySchema.parse(req.query);
    const page = await history(req.seller!.id, query.bucket, query.page, query.pageSize);
    res.json({ success: true, data: page });
  } catch (err) {
    next(err);
  }
});
