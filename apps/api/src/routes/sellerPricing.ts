import { Router } from 'express';
import type { SellerEconomicsRates } from '@clowe/shared';
import { requireAuth } from '../middleware/auth';
import { getSettings } from '../services/settingsService';
import { economicsRates } from '../services/payoutService';
import { requireSeller } from './seller';

export const sellerPricingRouter = Router();
sellerPricingRouter.use(requireAuth, requireSeller);

// The rates the shared calculator needs, so the product form can show a
// seller what a price will pay them with the same arithmetic the ledger uses.
sellerPricingRouter.get('/', async (_req, res, next) => {
  try {
    const rates: SellerEconomicsRates = economicsRates(await getSettings());
    res.json({ success: true, data: rates });
  } catch (err) {
    next(err);
  }
});
