import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, Role, SellerStatus, type SellerProfile } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { signAccessToken } from '../utils/jwt';

/**
 * The seller store's section saves (profile, business, shipping, returns,
 * vacation): for every optional field, absent is not empty. A save without
 * the field keeps what is stored, "" (or null) clears it, a value sets it.
 */

const prisma = new PrismaClient();
let server: Server;
let base: string;
let token: string;
let sellerId: string;
let categoryId: string;

/** What each section must always carry: its required fields. */
const REQUIRED: Record<string, Record<string, unknown>> = {
  profile: { shopName: 'Field Keeper Shop' },
  business: {},
  // Same-as-business skips the separate-address check, so each field can be tested alone.
  shipping: { pickupSameAsBusiness: true, codEnabled: true },
  returns: { returnAddressSameAsPickup: false },
  vacation: { vacationMode: false },
};

/** [section, field, a valid value] — every optional field the section saves. */
const FIELDS: Array<[string, keyof SellerProfile, unknown]> = [
  ['profile', 'tagline', 'Everything for the audit'],
  ['profile', 'description', 'A shop that exists to test field saves.'],
  ['profile', 'logoUrl', 'https://example.com/logo.png'],
  ['profile', 'bannerUrl', 'https://example.com/banner.png'],
  ['profile', 'storeEmail', 'shop@example.com'],
  ['profile', 'storePhone', '9876543210'],
  ['profile', 'primaryCategoryId', '<category>'],
  ['business', 'businessType', 'PROPRIETORSHIP'],
  ['business', 'gstNumber', '27ABCDE1234F1Z5'],
  ['business', 'panNumber', 'ABCDE1234F'],
  ['business', 'panName', 'FIELD KEEPER'],
  ['business', 'addressLine1', '1 Seller Lane'],
  ['business', 'addressLine2', 'Near the market'],
  ['business', 'landmark', 'Opposite the park'],
  ['business', 'city', 'Pune'],
  ['business', 'state', 'Maharashtra'],
  ['business', 'pincode', '411001'],
  ['shipping', 'pickupName', 'Pickup Desk'],
  ['shipping', 'pickupPhone', '9876543211'],
  ['shipping', 'pickupLine1', '2 Pickup Road'],
  ['shipping', 'pickupLine2', 'Gate 3'],
  ['shipping', 'pickupCity', 'Pune'],
  ['shipping', 'pickupState', 'Maharashtra'],
  ['shipping', 'pickupPincode', '411002'],
  ['returns', 'returnLine1', '3 Returns Street'],
  ['returns', 'returnCity', 'Pune'],
  ['returns', 'returnState', 'Maharashtra'],
  ['returns', 'returnPincode', '411003'],
  ['vacation', 'vacationMessage', 'Back on Monday'],
];

async function save(section: string, fields: Record<string, unknown>) {
  const res = await fetch(`${base}/api/seller/store/${section}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...REQUIRED[section], ...fields }),
  });
  if (res.status !== 200) throw new Error(`${section} ${JSON.stringify(fields)} → ${res.status} ${await res.text()}`);
}
const stored = async () => prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } });

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { phone: '9198400001', name: 'Field Keeper', role: Role.SELLER, referralCode: 'FLDK-1' },
  });
  const seller = await prisma.sellerProfile.create({
    data: { userId: user.id, shopName: 'Field Keeper Shop', status: SellerStatus.APPROVED, approvedAt: new Date() },
  });
  sellerId = seller.id;
  token = signAccessToken({ sub: user.id, role: 'SELLER' });
  categoryId = (await prisma.category.create({ data: { name: 'Field Keeper Wares', slug: 'field-keeper-wares', isActive: true } })).id;
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await prisma.$disconnect();
});

describe.each(FIELDS)('%s → %s', (section, field, sample) => {
  const value = () => (sample === '<category>' ? categoryId : sample);

  it('a value sets it', async () => {
    await save(section, { [field]: value() });
    expect((await stored())[field]).toBe(value());
  });

  it('a save without the field keeps it', async () => {
    await save(section, {});
    expect((await stored())[field]).toBe(value());
  });

  it('"" clears it', async () => {
    await save(section, { [field]: '' });
    expect((await stored())[field]).toBeNull();
  });
});

describe('a separate pickup address', () => {
  it('is complete when its street and PIN are stored, even if the save leaves them out', async () => {
    await save('shipping', { pickupLine1: '2 Pickup Road', pickupPincode: '411002' });
    await save('shipping', { pickupSameAsBusiness: false, pickupCity: 'Pune' });
    const after = await stored();
    expect([after.pickupSameAsBusiness, after.pickupLine1, after.pickupPincode]).toEqual([false, '2 Pickup Road', '411002']);
  });

  it('is refused when the save clears its street', async () => {
    await expect(save('shipping', { pickupSameAsBusiness: false, pickupLine1: '' })).rejects.toThrow('PICKUP_INCOMPLETE');
    expect((await stored()).pickupLine1).toBe('2 Pickup Road');
  });
});

describe('the non-text fields', () => {
  it('returns window: a value sets it, a save without it keeps it, null clears it', async () => {
    await save('returns', { returnWindowDays: 10 });
    expect((await stored()).returnWindowDays).toBe(10);
    await save('returns', {});
    expect((await stored()).returnWindowDays).toBe(10);
    await save('returns', { returnWindowDays: null });
    expect((await stored()).returnWindowDays).toBeNull();
  });

  it('vacation end date: a value sets it, a save without it keeps it, "" clears it', async () => {
    await save('vacation', { vacationUntil: '2026-12-31' });
    expect((await stored()).vacationUntil?.toISOString().slice(0, 10)).toBe('2026-12-31');
    await save('vacation', {});
    expect((await stored()).vacationUntil?.toISOString().slice(0, 10)).toBe('2026-12-31');
    await save('vacation', { vacationUntil: '' });
    expect((await stored()).vacationUntil).toBeNull();
  });
});
