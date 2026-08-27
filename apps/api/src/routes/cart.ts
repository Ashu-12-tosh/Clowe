import { Router } from 'express';
import { Prisma } from '@prisma/client';
import {
  cartBulkDeleteSchema,
  cartItemAddSchema,
  cartItemUpdateSchema,
  cartSelectAllSchema,
  couponApplySchema,
  type AppliedCoupon,
  type CartView,
  type CouponOffer,
} from '@clowe/shared';
import { prisma } from '../db';
import { applyPromotions } from '../services/promotionService';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import {
  deliveryOptionsFor,
  FREE_SHIPPING_THRESHOLD_PAISE,
  SHIPPING_FEE_PAISE,
  shippingFor,
} from '../services/deliveryService';

export const cartRouter = Router();
cartRouter.use(requireAuth);

// Shipping rules live in the delivery service (it also prices the faster
// speeds); re-exported here because orders/cart both reach for them.
export { FREE_SHIPPING_THRESHOLD_PAISE, SHIPPING_FEE_PAISE, shippingFor };

async function getOrCreateCart(userId: string) {
  const existing = await prisma.cart.findUnique({ where: { userId } });
  if (existing) return existing;
  try {
    return await prisma.cart.create({ data: { userId } });
  } catch (err) {
    // Two first-ever cart requests can race into the same insert; whichever
    // loses just reads the row the winner created.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const cart = await prisma.cart.findUnique({ where: { userId } });
      if (cart) return cart;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

type CouponRow = NonNullable<Awaited<ReturnType<typeof prisma.coupon.findUnique>>>;

/** Money off a given subtotal, honouring the percent cap. Never exceeds the subtotal. */
export function couponDiscountFor(coupon: CouponRow, subtotalPaise: number): number {
  const raw =
    coupon.type === 'PERCENT'
      ? Math.floor((subtotalPaise * coupon.value) / 100)
      : coupon.value;
  const capped = coupon.maxDiscountPaise ? Math.min(raw, coupon.maxDiscountPaise) : raw;
  return Math.max(0, Math.min(capped, subtotalPaise));
}

/**
 * Look a code up and check it can be used against this subtotal. Returns the
 * reason instead of throwing so a cart read can silently drop a code that
 * went stale, while POST /coupon can surface the message.
 */
export async function validateCoupon(
  code: string,
  subtotalPaise: number,
  userId?: string,
): Promise<{ coupon: CouponRow; discountPaise: number } | { error: string }> {
  const coupon = await prisma.coupon.findUnique({ where: { code: code.toUpperCase() } });
  if (!coupon || !coupon.isActive) return { error: 'That coupon code is not valid' };

  if (userId) {
    if (coupon.kind === 'PREMIUM') {
      const member = await prisma.user.findUnique({
        where: { id: userId },
        select: { isPremium: true },
      });
      if (!member?.isPremium) {
        return { error: `${coupon.code} is a Clowe Premium members-only offer` };
      }
    }
    if (coupon.perUserLimit !== null) {
      const mine = await prisma.order.count({
        where: { userId, couponCode: coupon.code, status: { not: 'CANCELLED' } },
      });
      if (mine >= coupon.perUserLimit) {
        return { error: `You have already used ${coupon.code}` };
      }
    }
  }

  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) return { error: 'This coupon is not active yet' };
  if (coupon.expiresAt && coupon.expiresAt < now) return { error: 'This coupon has expired' };
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    return { error: 'This coupon has been fully redeemed' };
  }
  if (subtotalPaise < coupon.minSubtotalPaise) {
    return {
      error: `Add items worth ₹${Math.ceil((coupon.minSubtotalPaise - subtotalPaise) / 100)} more to use ${coupon.code}`,
    };
  }
  const discountPaise = couponDiscountFor(coupon, subtotalPaise);
  if (discountPaise <= 0) return { error: 'This coupon gives no discount on your cart' };
  return { coupon, discountPaise };
}

// ---------------------------------------------------------------------------
// Cart view
// ---------------------------------------------------------------------------

export async function buildCartView(userId: string): Promise<CartView> {
  const cart = await getOrCreateCart(userId);
  const items = await prisma.cartItem.findMany({
    where: { cartId: cart.id },
    orderBy: { createdAt: 'asc' },
    include: {
      variant: {
        include: {
          product: {
            include: {
              images: { orderBy: { sortOrder: 'asc' }, take: 1 },
              category: { include: { parent: { select: { id: true, slug: true } } } },
            },
          },
        },
      },
    },
  });

  // Drop lines whose product is no longer live (rejected/archived after adding).
  const liveItems = items.filter((i) => i.variant.product.status === 'APPROVED');

  // Seller promotions are resolved before the totals: they come off the line
  // price, so everything downstream (order, invoice, payout) sees the real
  // amount paid. A coded promotion only applies when its code is on the cart.
  const promotions = await applyPromotions(
    liveItems
      .filter((i) => i.selected)
      .map((i) => ({
        variantId: i.variantId,
        productId: i.variant.productId,
        sellerId: i.variant.product.sellerId,
        categoryId: i.variant.product.categoryId,
        rootCategoryId: i.variant.product.category.parent?.id ?? i.variant.product.categoryId,
        pricePaise: i.variant.pricePaise,
        quantity: i.quantity,
      })),
    { userId, enteredCode: cart.couponCode },
  );

  const lines = liveItems
    .map((i) => ({
      id: i.id,
      variantId: i.variantId,
      productId: i.variant.productId,
      slug: i.variant.product.slug,
      title: i.variant.product.title,
      brand: i.variant.product.brand,
      imageUrl: i.variant.product.images[0]?.url ?? null,
      size: i.variant.size,
      color: i.variant.color,
      pricePaise: i.variant.pricePaise,
      mrpPaise: i.variant.mrpPaise,
      stock: i.variant.stock,
      quantity: i.quantity,
      selected: i.selected,
      rootCategorySlug:
        i.variant.product.category.parent?.slug ?? i.variant.product.category.slug,
      promotion: promotions.get(i.variantId)
        ? {
            id: promotions.get(i.variantId)!.promotionId,
            name: promotions.get(i.variantId)!.name,
            code: promotions.get(i.variantId)!.code,
          }
        : null,
      promoDiscountPaise: promotions.get(i.variantId)?.discountPaise ?? 0,
    }));

  // Totals are built from ticked lines only — unticked ones ride along in the
  // cart but are not being bought right now.
  const selected = lines.filter((l) => l.selected);
  const listSubtotalPaise = selected.reduce((sum, l) => sum + l.pricePaise * l.quantity, 0);
  const promoDiscountPaise = selected.reduce((sum, l) => sum + l.promoDiscountPaise, 0);
  const subtotalPaise = listSubtotalPaise - promoDiscountPaise;
  const mrpSubtotalPaise = selected.reduce(
    (sum, l) => sum + Math.max(l.mrpPaise ?? l.pricePaise, l.pricePaise) * l.quantity,
    0,
  );
  const member = await prisma.user.findUnique({
    where: { id: userId },
    select: { isPremium: true },
  });
  const shippingPaise = shippingFor(subtotalPaise, member?.isPremium ?? false);

  // Re-check the applied coupon on every read; if it no longer qualifies
  // (cart shrank, code expired) it silently falls off the cart.
  let coupon: AppliedCoupon | null = null;
  let couponDiscountPaise = 0;
  if (cart.couponCode) {
    const result = await validateCoupon(cart.couponCode, subtotalPaise, userId);
    if ('error' in result) {
      await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
    } else {
      couponDiscountPaise = result.discountPaise;
      coupon = {
        code: result.coupon.code,
        description: result.coupon.description,
        discountPaise: couponDiscountPaise,
      };
    }
  }

  // Catalogue discount = MRP minus what is being charged before coupons.
  const discountPaise = mrpSubtotalPaise - listSubtotalPaise;

  const appliedPromotions = new Map<
    string,
    { id: string; name: string; code: string | null; discountPaise: number }
  >();
  for (const line of selected) {
    if (!line.promotion || line.promoDiscountPaise <= 0) continue;
    const entry = appliedPromotions.get(line.promotion.id) ?? {
      ...line.promotion,
      discountPaise: 0,
    };
    entry.discountPaise += line.promoDiscountPaise;
    appliedPromotions.set(line.promotion.id, entry);
  }

  return {
    lines,
    selectedCount: selected.length,
    mrpSubtotalPaise,
    subtotalPaise,
    discountPaise,
    shippingPaise,
    coupon,
    couponDiscountPaise,
    promoDiscountPaise,
    promotions: [...appliedPromotions.values()],
    totalPaise: subtotalPaise + shippingPaise - couponDiscountPaise,
    savingsPaise: discountPaise + promoDiscountPaise + couponDiscountPaise,
    freeShippingThresholdPaise: FREE_SHIPPING_THRESHOLD_PAISE,
  };
}

/** Every cart write answers with the whole recomputed cart. */
async function respondWithCart(userId: string, res: import('express').Response) {
  res.json({ success: true, data: await buildCartView(userId) });
}

cartRouter.get('/', async (req, res, next) => {
  try {
    await respondWithCart(req.auth!.userId, res);
  } catch (err) {
    next(err);
  }
});

// Add a variant (or bump its quantity if already in the cart).
cartRouter.post('/items', async (req, res, next) => {
  try {
    // Store is view-only for seller/admin accounts.
    if (req.auth!.role !== 'CUSTOMER') {
      throw ApiError.forbidden(
        'Seller/admin accounts can view the store but cannot purchase',
        'PURCHASE_CUSTOMER_ONLY',
      );
    }
    const { variantId, quantity } = cartItemAddSchema.parse(req.body);
    const variant = await prisma.productVariant.findUnique({
      where: { id: variantId },
      include: { product: { select: { status: true } } },
    });
    if (!variant || variant.product.status !== 'APPROVED') {
      throw ApiError.notFound('Product not available');
    }
    if (variant.stock < quantity) {
      throw ApiError.badRequest(`Only ${variant.stock} left in stock`, 'OUT_OF_STOCK');
    }

    const cart = await getOrCreateCart(req.auth!.userId);
    const existing = await prisma.cartItem.findUnique({
      where: { cartId_variantId: { cartId: cart.id, variantId } },
    });
    const newQty = Math.min((existing?.quantity ?? 0) + quantity, 10, variant.stock);
    await prisma.cartItem.upsert({
      where: { cartId_variantId: { cartId: cart.id, variantId } },
      // A re-add re-ticks the line — you just said you want it.
      update: { quantity: newQty, selected: true },
      create: { cartId: cart.id, variantId, quantity },
    });
    await respondWithCart(req.auth!.userId, res);
  } catch (err) {
    next(err);
  }
});

// Tick / untick every line at once ("Select All").
cartRouter.post('/select-all', async (req, res, next) => {
  try {
    const { selected } = cartSelectAllSchema.parse(req.body);
    const cart = await getOrCreateCart(req.auth!.userId);
    await prisma.cartItem.updateMany({ where: { cartId: cart.id }, data: { selected } });
    await respondWithCart(req.auth!.userId, res);
  } catch (err) {
    next(err);
  }
});

// Remove several lines at once ("Delete Selected").
cartRouter.post('/items/bulk-delete', async (req, res, next) => {
  try {
    const { ids } = cartBulkDeleteSchema.parse(req.body);
    const cart = await getOrCreateCart(req.auth!.userId);
    await prisma.cartItem.deleteMany({ where: { id: { in: ids }, cartId: cart.id } });
    await respondWithCart(req.auth!.userId, res);
  } catch (err) {
    next(err);
  }
});

// Move a line to the wishlist ("save for later" — the heart on each row).
cartRouter.post('/items/:id/move-to-wishlist', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const cart = await getOrCreateCart(userId);
    const item = await prisma.cartItem.findUnique({
      where: { id: req.params.id },
      include: { variant: { select: { productId: true } } },
    });
    if (!item || item.cartId !== cart.id) throw ApiError.notFound('Cart item not found');

    await prisma.$transaction([
      prisma.wishlist.upsert({
        where: { userId_productId: { userId, productId: item.variant.productId } },
        update: {},
        create: { userId, productId: item.variant.productId },
      }),
      prisma.cartItem.delete({ where: { id: item.id } }),
    ]);
    await respondWithCart(userId, res);
  } catch (err) {
    next(err);
  }
});

// Set a line's quantity and/or its ticked state.
cartRouter.patch('/items/:id', async (req, res, next) => {
  try {
    const { quantity, selected } = cartItemUpdateSchema.parse(req.body);
    const cart = await getOrCreateCart(req.auth!.userId);
    const item = await prisma.cartItem.findUnique({
      where: { id: req.params.id },
      include: { variant: true },
    });
    if (!item || item.cartId !== cart.id) throw ApiError.notFound('Cart item not found');
    if (quantity !== undefined && item.variant.stock < quantity) {
      throw ApiError.badRequest(`Only ${item.variant.stock} left in stock`, 'OUT_OF_STOCK');
    }
    await prisma.cartItem.update({
      where: { id: item.id },
      data: {
        ...(quantity !== undefined ? { quantity } : {}),
        ...(selected !== undefined ? { selected } : {}),
      },
    });
    await respondWithCart(req.auth!.userId, res);
  } catch (err) {
    next(err);
  }
});

cartRouter.delete('/items/:id', async (req, res, next) => {
  try {
    const cart = await getOrCreateCart(req.auth!.userId);
    await prisma.cartItem.deleteMany({ where: { id: req.params.id, cartId: cart.id } });
    await respondWithCart(req.auth!.userId, res);
  } catch (err) {
    next(err);
  }
});

// Empty the cart ("Clear Cart").
cartRouter.delete('/', async (req, res, next) => {
  try {
    const cart = await getOrCreateCart(req.auth!.userId);
    await prisma.$transaction([
      prisma.cartItem.deleteMany({ where: { cartId: cart.id } }),
      prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } }),
    ]);
    await respondWithCart(req.auth!.userId, res);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Coupon apply / remove
// ---------------------------------------------------------------------------

cartRouter.post('/coupon', async (req, res, next) => {
  try {
    const { code } = couponApplySchema.parse(req.body);
    const userId = req.auth!.userId;
    const cart = await getOrCreateCart(userId);
    // Validate against the current ticked subtotal, not the whole cart.
    const { subtotalPaise } = await buildCartView(userId);
    const result = await validateCoupon(code, subtotalPaise, userId);
    if ('error' in result) {
      // Not a platform coupon — it may be a seller's promotion code, which is
      // stored on the cart the same way and resolved per line in the view.
      const promotion = await prisma.promotion.findUnique({
        where: { code: code.trim().toUpperCase() },
      });
      const now = new Date();
      const live =
        promotion &&
        promotion.state === 'ACTIVE' &&
        promotion.startAt <= now &&
        promotion.endAt >= now &&
        (promotion.usageLimit === null || promotion.usedCount < promotion.usageLimit);
      if (!live) throw ApiError.badRequest(result.error, 'COUPON_INVALID');

      await prisma.cart.update({
        where: { id: cart.id },
        data: { couponCode: promotion!.code },
      });
      const view = await buildCartView(userId);
      if (view.promoDiscountPaise <= 0) {
        await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
        throw ApiError.badRequest(
          `${promotion!.code} does not apply to anything in your cart`,
          'COUPON_INVALID',
        );
      }
      res.json({ success: true, data: view });
      return;
    }

    await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: result.coupon.code } });
    await respondWithCart(userId, res);
  } catch (err) {
    next(err);
  }
});

cartRouter.delete('/coupon', async (req, res, next) => {
  try {
    const cart = await getOrCreateCart(req.auth!.userId);
    await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
    await respondWithCart(req.auth!.userId, res);
  } catch (err) {
    next(err);
  }
});

// Delivery speeds priced for the current cart — the checkout's step 2.
cartRouter.get('/delivery-options', async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const [{ subtotalPaise }, member] = await Promise.all([
      buildCartView(userId),
      prisma.user.findUnique({ where: { id: userId }, select: { isPremium: true } }),
    ]);
    res.json({
      success: true,
      data: deliveryOptionsFor(subtotalPaise, new Date(), member?.isPremium ?? false),
    });
  } catch (err) {
    next(err);
  }
});

// Coupons a shopper can browse from the "Add Coupon" panel. Only currently
// usable, publicly listable codes.
cartRouter.get('/coupons', async (_req, res, next) => {
  try {
    const now = new Date();
    const coupons = await prisma.coupon.findMany({
      where: {
        isActive: true,
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] }],
      },
      orderBy: { minSubtotalPaise: 'asc' },
      take: 12,
    });
    res.json({
      success: true,
      data: coupons
        .filter((c) => c.usageLimit === null || c.usedCount < c.usageLimit)
        .map((c) => ({
          code: c.code,
          description: c.description,
          type: c.type,
          value: c.value,
          minSubtotalPaise: c.minSubtotalPaise,
          maxDiscountPaise: c.maxDiscountPaise,
          expiresAt: c.expiresAt?.toISOString() ?? null,
          kind: (c.kind as CouponOffer['kind']) ?? 'STANDARD',
        })),
    });
  } catch (err) {
    next(err);
  }
});
