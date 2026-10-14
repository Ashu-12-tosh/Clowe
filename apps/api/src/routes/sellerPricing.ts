import { Router } from 'express';
import { z } from 'zod';
import { buyerPriceFor, type SellerEconomicsRates } from '@clowe/shared';
import { requireAuth } from '../middleware/auth';
import { getSettings } from '../services/settingsService';
import { economicsRates } from '../services/payoutService';
import { requireSeller } from './seller';
import { deliveryEstimate } from '../services/shipping/deliveryEstimate';
import { categoryRulesMap } from '../services/categoryRules';

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

const estimateQuery = z.object({
  weightGrams: z.coerce.number().int().min(1).max(100_000),
  lengthMm: z.coerce.number().int().min(1).max(3_000).optional(),
  widthMm: z.coerce.number().int().min(1).max(3_000).optional(),
  heightMm: z.coerce.number().int().min(1).max(3_000).optional(),
  /** The seller's price before GST: the COD fee is on what the buyer pays. */
  pricePaise: z.coerce.number().int().min(0).max(100_000_000).default(0),
  categoryId: z.string().optional(),
});

// What one parcel of this product costs to send, for the pricing calculator.
sellerPricingRouter.get('/delivery-estimate', async (req, res, next) => {
  try {
    const q = estimateQuery.parse(req.query);
    const settings = await getSettings();
    const rules = q.categoryId ? (await categoryRulesMap([q.categoryId])).get(q.categoryId) ?? null : null;
    const buyerPaise = q.pricePaise > 0 ? buyerPriceFor(q.pricePaise, rules, economicsRates(settings).gst).buyerPaise : 0;
    const estimate = await deliveryEstimate(
      req.seller!.id,
      { weightGrams: q.weightGrams, lengthMm: q.lengthMm ?? null, widthMm: q.widthMm ?? null, heightMm: q.heightMm ?? null },
      buyerPaise,
    );
    res.json({ success: true, data: estimate });
  } catch (err) {
    next(err);
  }
});
