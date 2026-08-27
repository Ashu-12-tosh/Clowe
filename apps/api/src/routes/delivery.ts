import { Router } from 'express';
import { z } from 'zod';
import { deliveryOptionsFor } from '../services/deliveryService';

export const deliveryRouter = Router();

const querySchema = z.object({
  /** Order value the options are priced against (free-shipping threshold). */
  subtotalPaise: z.coerce.number().int().min(0).default(0),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter a valid 6-digit pincode')
    .optional(),
});

/**
 * Serviceability + delivery speeds for a pincode. Public, so the product page
 * can quote delivery before login. Coverage is a stand-in until a real courier
 * serviceability API is wired in: every valid 6-digit pincode is served, and
 * remote ones (starting 19x/79x/9xx) lose the same-day option.
 */
deliveryRouter.get('/options', (req, res, next) => {
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
    const { subtotalPaise, pincode } = parsed.data;
    const remote = pincode ? /^(19|79|9)/.test(pincode) : false;
    const options = deliveryOptionsFor(subtotalPaise).map((option) =>
      remote && option.method === 'SAME_DAY'
        ? {
            ...option,
            available: false,
            unavailableReason: 'Same-day delivery is not available at this pincode',
          }
        : option,
    );

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
