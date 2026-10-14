import { Router } from 'express';
import { z } from 'zod';
import { deliveryOptionsFor } from '../services/deliveryService';

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
 * quote delivery before login. Delivery is always free. Coverage is a
 * stand-in until checkout reads Delhivery's serviceability: every valid
 * 6-digit pincode is served.
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
    const options = deliveryOptionsFor();

    res.json({
      success: true,
      data: {
        pincode: pincode ?? null,
        serviceable: true,
        message: null,
        options,
      },
    });
  } catch (err) {
    next(err);
  }
});
