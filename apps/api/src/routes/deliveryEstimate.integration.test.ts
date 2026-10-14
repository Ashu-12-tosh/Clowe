import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { DEFAULT_SETTINGS, setSetting } from '../services/settingsService';
import { shippingProvider } from '../services/shipping';
import { clearDeliveryEstimateCache } from '../services/shipping/deliveryEstimate';
import { signAccessToken } from '../utils/jwt';

/**
 * The pricing calculator's delivery estimate: what one parcel of a product
 * costs the seller to send from their pickup pincode — to their own city, a
 * metro and somewhere far — plus what COD adds. Priced on the greater of
 * actual and volumetric weight, rounded up to Delhivery's 0.5 kg slab, and
 * cached per slab and route when the real courier is in use.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
const TEST_RATE = 7_000;
let seq = 0;

async function seller(pincode: string | null) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `91955000${String(seq).padStart(2, '0')}`, name: `Estimate Seller ${seq}`, role: Role.SELLER, referralCode: `EST-${seq}` },
  });
  await prisma.sellerProfile.create({
    data: {
      userId: user.id, shopName: `Estimate Shop ${seq}`, status: SellerStatus.APPROVED, approvedAt: new Date(),
      ...(pincode ? { addressLine1: '1 Road', city: 'City', state: 'State', pincode } : {}),
    },
  });
  return signAccessToken({ sub: user.id, role: 'SELLER' });
}

async function estimate(token: string, query: string) {
  const res = await fetch(`${base}/api/seller/pricing-rates/delivery-estimate?${query}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, data: ((await res.json()) as { data: Record<string, unknown> }).data };
}

beforeAll(async () => {
  await setSetting('deliveryFeePaise', TEST_RATE);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await setSetting('deliveryFeePaise', DEFAULT_SETTINGS.deliveryFeePaise);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('the delivery estimate', () => {
  it('prices the box by the greater of actual and volumetric weight, in 0.5 kg slabs, to three destinations', async () => {
    const token = await seller('110053');
    const quote = vi.spyOn(shippingProvider, 'quote');
    // 300 g in a 40 × 30 × 10 cm box: 2.4 kg volumetric, charged as 2.5 kg.
    const r = await estimate(token, 'weightGrams=300&lengthMm=400&widthMm=300&heightMm=100&pricePaise=50000');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      originPincode: '110053',
      chargeableGrams: 2_400,
      slabGrams: 2_500,
      provider: 'mock',
      error: null,
      cases: [
        { key: 'local', label: 'Same city', destinationPincode: '110053', freightPaise: TEST_RATE },
        { key: 'metro', label: 'Metro', destinationPincode: '400001', freightPaise: TEST_RATE },
        { key: 'far', label: 'Far (J&K)', destinationPincode: '190001', freightPaise: TEST_RATE },
      ],
    });
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ originPincode: '110053', weightGrams: 2_500, kind: 'DELIVERED', payment: 'PREPAID', mode: 'SURFACE' }));
    quote.mockRestore();
  });

  it('adds what COD costs at the buyer’s price: ₹40 or 2 %, plus GST, from the charges API', async () => {
    const token = await seller('110053');
    // ₹500 before GST is ₹590 to the buyer: 2 % is ₹11.80, so ₹40 + GST.
    expect((await estimate(token, 'weightGrams=500&pricePaise=50000')).data.codFeePaise).toBe(4_720);
    // ₹5,000 before GST is ₹5,900: 2 % is ₹118, plus GST.
    expect((await estimate(token, 'weightGrams=500&pricePaise=500000')).data.codFeePaise).toBe(13_924);
  });

  it('picks another metro for a seller in Mumbai, and asks for the pincode when there is none', async () => {
    const mumbai = await seller('400053');
    const cases = (await estimate(mumbai, 'weightGrams=500')).data.cases as { key: string; destinationPincode: string }[];
    expect(cases.map((c) => c.destinationPincode)).toEqual(['400053', '110001', '190001']);
    const none = await seller(null);
    expect((await estimate(none, 'weightGrams=500')).data).toMatchObject({ cases: [], error: expect.stringMatching(/pickup pincode/) });
  });

  it('asks the real courier once per route and slab, however the weight is typed within it', async () => {
    const token = await seller('110053');
    clearDeliveryEstimateCache();
    Object.defineProperty(shippingProvider, 'name', { value: 'delhivery', configurable: true, writable: true });
    const quote = vi.spyOn(shippingProvider, 'quote');
    try {
      await estimate(token, 'weightGrams=2100');
      await estimate(token, 'weightGrams=2300'); // same 2.5 kg slab
      expect(quote).toHaveBeenCalledTimes(3);
      await estimate(token, 'weightGrams=2600'); // the next slab: asked again
      expect(quote).toHaveBeenCalledTimes(6);
    } finally {
      Object.defineProperty(shippingProvider, 'name', { value: 'mock', configurable: true, writable: true });
      quote.mockRestore();
      clearDeliveryEstimateCache();
    }
  });
});
