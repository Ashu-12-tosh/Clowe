import { Router } from 'express';
import { z } from 'zod';
import { buyerPriceFor, type PricingRatesView, type SellerEconomicsRates } from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { getCommercial, handlingWaivedFor } from '../services/commercial';
import { requireAuth } from '../middleware/auth';
import { getSettings } from '../services/settingsService';
import { economicsRates } from '../services/payoutService';
import { requireSeller } from './seller';
import { deliveryEstimate } from '../services/shipping/deliveryEstimate';
import { categoryRulesMap } from '../services/categoryRules';
import { referralSlabsByCategory } from '../services/referralFees/views';

export const sellerPricingRouter = Router();
sellerPricingRouter.use(requireAuth, requireSeller);

// The rates the shared calculator needs, so the product form can show a
// seller what a price will pay them with the same arithmetic the ledger uses.
sellerPricingRouter.get('/', async (req, res, next) => {
  try {
    // New orders are charged the owner's Batch 2 fees: the calculator shows those.
    const c = await getCommercial();
    const waived = (await handlingWaivedFor([req.seller!.id])).get(req.seller!.id) ?? false;
    const categories = await prisma.category.findMany({ select: { id: true, referralPercent: true } });
    const rates: SellerEconomicsRates & PricingRatesView = {
      ...economicsRates(await getSettings()),
      v2: { ...c.fees, handlingWaived: waived },
      categoryReferralPercent: Object.fromEntries(categories.map((cat) => [cat.id, cat.referralPercent])),
      // The fee schedule's slabs where a category has them: the rate follows the price.
      categoryReferralSlabs: await referralSlabsByCategory(),
    };
    res.json({ success: true, data: rates });
  } catch (err) {
    next(err);
  }
});

const estimateQuery = z.object({
  /** Or a product of the seller's own: its saved weight and box. */
  productId: z.string().min(1).max(64).optional(),
  weightGrams: z.coerce.number().int().min(1).max(100_000).optional(),
  lengthMm: z.coerce.number().int().min(1).max(3_000).optional(),
  widthMm: z.coerce.number().int().min(1).max(3_000).optional(),
  heightMm: z.coerce.number().int().min(1).max(3_000).optional(),
  /** The seller's price before GST: the COD fee is on what the buyer pays. */
  pricePaise: z.coerce.number().int().min(0).max(100_000_000).default(0),
  categoryId: z.string().optional(),
  /** A PIN the seller wants priced besides the three sample places. */
  destinationPincode: z.string().trim().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit pincode').optional(),
});

// What one parcel of this product costs to send, for the pricing calculator.
sellerPricingRouter.get('/delivery-estimate', async (req, res, next) => {
  try {
    const q = estimateQuery.parse(req.query);
    const settings = await getSettings();
    const product = q.productId
      ? await prisma.product.findFirst({
          where: { id: q.productId, sellerId: req.seller!.id },
          select: { weightGrams: true, lengthMm: true, widthMm: true, heightMm: true, categoryId: true },
        })
      : null;
    if (q.productId && !product) throw ApiError.notFound('Product not found');
    const weightGrams = product?.weightGrams ?? q.weightGrams;
    if (!weightGrams) throw ApiError.badRequest(product ? 'This product has no weight yet — add it on the product form' : 'Enter the weight');
    const categoryId = product?.categoryId ?? q.categoryId;
    const rules = categoryId ? (await categoryRulesMap([categoryId])).get(categoryId) ?? null : null;
    const buyerPaise = q.pricePaise > 0 ? buyerPriceFor(q.pricePaise, rules, economicsRates(settings).gst).buyerPaise : 0;
    const box = product ?? { lengthMm: q.lengthMm ?? null, widthMm: q.widthMm ?? null, heightMm: q.heightMm ?? null };
    const estimate = await deliveryEstimate(
      req.seller!.id,
      { weightGrams, lengthMm: box.lengthMm, widthMm: box.widthMm, heightMm: box.heightMm },
      buyerPaise,
      { destinationPincode: q.destinationPincode ?? null },
    );
    res.json({ success: true, data: estimate });
  } catch (err) {
    next(err);
  }
});

// The seller's products with their parcel sizes, for the shipping charges
// calculator's "pick a product".
sellerPricingRouter.get('/parcels', async (req, res, next) => {
  try {
    const rows = await prisma.product.findMany({
      where: { sellerId: req.seller!.id, status: { not: 'ARCHIVED' } },
      orderBy: { updatedAt: 'desc' },
      take: 500,
      select: { id: true, title: true, weightGrams: true, lengthMm: true, widthMm: true, heightMm: true },
    });
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});
