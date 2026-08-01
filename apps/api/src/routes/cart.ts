import { Router } from 'express';
import { cartItemAddSchema, cartItemUpdateSchema, type CartView } from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';

export const cartRouter = Router();
cartRouter.use(requireAuth);

// Shipping rule: free at/above ₹999, else ₹49.
export const FREE_SHIPPING_THRESHOLD_PAISE = 99900;
export const SHIPPING_FEE_PAISE = 4900;

export function shippingFor(subtotalPaise: number): number {
  if (subtotalPaise === 0) return 0;
  return subtotalPaise >= FREE_SHIPPING_THRESHOLD_PAISE ? 0 : SHIPPING_FEE_PAISE;
}

async function getOrCreateCart(userId: string) {
  return prisma.cart.upsert({ where: { userId }, update: {}, create: { userId } });
}

export async function buildCartView(userId: string): Promise<CartView> {
  const cart = await getOrCreateCart(userId);
  const items = await prisma.cartItem.findMany({
    where: { cartId: cart.id },
    orderBy: { createdAt: 'asc' },
    include: {
      variant: {
        include: {
          product: {
            include: { images: { orderBy: { sortOrder: 'asc' }, take: 1 } },
          },
        },
      },
    },
  });

  // Drop lines whose product is no longer live (rejected/archived after adding).
  const lines = items
    .filter((i) => i.variant.product.status === 'APPROVED')
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
    }));

  const subtotalPaise = lines.reduce((sum, l) => sum + l.pricePaise * l.quantity, 0);
  const shippingPaise = shippingFor(subtotalPaise);
  return {
    lines,
    subtotalPaise,
    shippingPaise,
    totalPaise: subtotalPaise + shippingPaise,
    freeShippingThresholdPaise: FREE_SHIPPING_THRESHOLD_PAISE,
  };
}

cartRouter.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await buildCartView(req.auth!.userId) });
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
      update: { quantity: newQty },
      create: { cartId: cart.id, variantId, quantity },
    });
    res.json({ success: true, data: await buildCartView(req.auth!.userId) });
  } catch (err) {
    next(err);
  }
});

// Set a line's quantity.
cartRouter.patch('/items/:id', async (req, res, next) => {
  try {
    const { quantity } = cartItemUpdateSchema.parse(req.body);
    const cart = await getOrCreateCart(req.auth!.userId);
    const item = await prisma.cartItem.findUnique({
      where: { id: req.params.id },
      include: { variant: true },
    });
    if (!item || item.cartId !== cart.id) throw ApiError.notFound('Cart item not found');
    if (item.variant.stock < quantity) {
      throw ApiError.badRequest(`Only ${item.variant.stock} left in stock`, 'OUT_OF_STOCK');
    }
    await prisma.cartItem.update({ where: { id: item.id }, data: { quantity } });
    res.json({ success: true, data: await buildCartView(req.auth!.userId) });
  } catch (err) {
    next(err);
  }
});

cartRouter.delete('/items/:id', async (req, res, next) => {
  try {
    const cart = await getOrCreateCart(req.auth!.userId);
    await prisma.cartItem.deleteMany({ where: { id: req.params.id, cartId: cart.id } });
    res.json({ success: true, data: await buildCartView(req.auth!.userId) });
  } catch (err) {
    next(err);
  }
});
