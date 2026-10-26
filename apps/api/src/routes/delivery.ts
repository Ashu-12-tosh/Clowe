import { Router } from 'express';
import { z } from 'zod';
import { deliveryOptionsFor } from '../services/deliveryService';
import { deliveryRefusal, pincodeServiceability } from '../services/shipping/serviceability';
import { DELIVERY_NOT_AVAILABLE, type ProductDeliveryPromise } from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { promisesFor, promiseView } from '../services/shipping/deliveryPromises';

export const deliveryRouter = Router();

const querySchema = z.object({
  /** Ignored: delivery is free at any order value. Accepted for older pages. */
  subtotalPaise: z.coerce.number().int().min(0).default(0),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter a valid 6-digit pincode')
    .optional(),
});

/**
 * Serviceability + delivery for a pincode. Public, so the product page can
 * quote delivery before login. Delivery is always free. Coverage is
 * Delhivery's (cached per pincode); if it can't be asked, the pincode is
 * treated as served — checkout and booking ask again.
 */
deliveryRouter.get('/options', async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.json({
        success: true,
        data: {
          pincode: String(req.query.pincode ?? ''),
          serviceable: false,
          message: parsed.error.issues[0].message,
          options: [],
        },
      });
      return;
    }
    const { pincode } = parsed.data;
    const check = pincode ? await pincodeServiceability(pincode) : null;
    const refused = pincode ? deliveryRefusal(pincode, check) : null;
    if (refused) {
      res.json({ success: true, data: { pincode, serviceable: false, message: refused, options: [], codAvailable: false } });
      return;
    }
    const options = deliveryOptionsFor(new Date(), pincode);

    res.json({
      success: true,
      data: {
        pincode: pincode ?? null,
        serviceable: true,
        message: null,
        options,
        codAvailable: check ? check.cod : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

const promiseQuery = z.object({
  productId: z.string().min(1).max(64),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a valid 6-digit pincode'),
});

/**
 * The product page's PIN check: the day this product arrives there from its
 * seller's pickup pincode, or that it can't. Public. Delhivery's answers are
 * cached for a day; when it can't be asked the zone range is shown instead,
 * and the product counts as deliverable (checkout asks again).
 */
deliveryRouter.get('/promise', async (req, res, next) => {
  try {
    const parsed = promiseQuery.safeParse(req.query);
    if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]!.message, 'BAD_PINCODE');
    const { productId, pincode } = parsed.data;
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { sellerId: true } });
    if (!product) throw ApiError.notFound('Product not found');
    const [promise] = await promisesFor([product.sellerId], pincode);
    const view = promise ? promiseView(promise) : null;
    const deliverable = view?.deliverable !== false;
    const body: ProductDeliveryPromise = {
      pincode,
      deliverable,
      message: deliverable && view ? `${view.label} · Free delivery` : DELIVERY_NOT_AVAILABLE,
      deliveryBy: view?.deliveryBy ?? null,
      deliveryByLatest: view?.deliveryByLatest ?? null,
      source: view?.source ?? null,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
