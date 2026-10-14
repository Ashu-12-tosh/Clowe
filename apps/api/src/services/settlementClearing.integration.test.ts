import { PrismaClient, ProductStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedFixture } from '../test/fixture';
import { postDeliveryEntries, postReturnReversal, settlementPosition } from './sellerLedgerService';

/**
 * A sale returned inside the payout hold is not money on its way. The
 * delivery's entries were counted as clearing while the return's reversal was
 * taken off at once, so the payouts page said "₹341.57 is clearing" for a
 * sale that had been refunded. The reversal now clears with the sale.
 */

const prisma = new PrismaClient();
let sellerId: string;
let itemId: string;

beforeAll(async () => {
  await seedFixture(prisma);
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { slug: 'fixture-store' } });
  sellerId = seller.id;
  const category = await prisma.category.findFirstOrThrow({ where: { slug: 'books' } });
  const product = await prisma.product.create({
    data: { sellerId, categoryId: category.id, title: 'Clearing Book', slug: 'clearing-book', description: 'Clearing test.', basePricePaise: 52_395, status: ProductStatus.APPROVED, approvedAt: new Date() },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, optionValues: {}, optionsKey: '', label: '', sku: 'SKU-CLEAR', pricePaise: 52_395, stock: 5 },
  });
  const buyer = await prisma.user.create({ data: { phone: '9198200001', name: 'Clearing Buyer', referralCode: 'CLR-B' } });
  const order = await prisma.order.create({
    data: {
      userId: buyer.id,
      orderNumber: 'CLW-CLEARTEST1',
      status: 'DELIVERED',
      paymentMethod: 'UPI',
      subtotalPaise: 52_395,
      shippingPaise: 0,
      totalPaise: 52_395,
      shipName: 'Clearing Buyer', shipPhone: '9198200001', shipLine1: '1 Test Road', shipCity: 'Pune', shipState: 'Maharashtra', shipPincode: '411001',
      items: {
        create: {
          sellerId, productId: product.id, variantId: variant.id, title: 'Clearing Book', size: '', color: '', variantLabel: '',
          pricePaise: 52_395, quantity: 1, status: 'DELIVERED', deliveredAt: new Date(),
        },
      },
    },
    include: { items: true },
  });
  itemId = order.items[0]!.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the settlement position', () => {
  it('counts a sale delivered inside the hold as clearing', async () => {
    await postDeliveryEntries(itemId);
    const pos = await settlementPosition(sellerId, 7);
    expect(pos.clearingPaise).toBeGreaterThan(0);
    expect(pos.availablePaise).toBe(0);
  });

  it('shows nothing clearing — and nothing taken off — once that sale is returned inside the hold', async () => {
    await prisma.orderItem.update({ where: { id: itemId }, data: { status: 'RETURNED' } });
    await postReturnReversal(itemId);
    expect(await settlementPosition(sellerId, 7)).toEqual({ balancePaise: 0, availablePaise: 0, clearingPaise: 0, codAwaitingPaise: 0 });
  });
});
