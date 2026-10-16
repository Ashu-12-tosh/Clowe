import { Router } from 'express';
import { z } from 'zod';
import { deliveryOptionsFor } from '../services/deliveryService';
import { deliveryRefusal, pincodeServiceability } from '../services/shipping/serviceability';

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
