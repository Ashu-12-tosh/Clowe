import { PrismaClient, Role, TryOnStatus } from '@prisma/client';
import { generateReferralCode } from '../../src/utils/crypto';

/**
 * Demo AI Try-On history so the admin monitor has something to monitor.
 * Deterministic (seeded PRNG) — reruns produce the same dashboard.
 */

const DAYS = 45;
const RUNS_PER_DAY_MIN = 6;
const RUNS_PER_DAY_MAX = 22;

/** Mulberry32 — small deterministic PRNG. */
function makeRandom(seed: number) {
  let state = seed;
  return function random(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHOPPERS = [
  { phone: '9200000001', name: 'Rahul Sharma', gender: 'MALE' },
  { phone: '9200000002', name: 'Priya Verma', gender: 'FEMALE' },
  { phone: '9200000003', name: 'Ankit Singh', gender: 'MALE' },
  { phone: '9200000004', name: 'Neha Kapoor', gender: 'FEMALE' },
  { phone: '9200000005', name: 'Vikram Mehta', gender: 'MALE' },
  { phone: '9200000006', name: 'Sneha Iyer', gender: 'FEMALE' },
  { phone: '9200000007', name: 'Rohit Das', gender: 'MALE' },
  { phone: '9200000008', name: 'Karan Patel', gender: 'MALE' },
  { phone: '9200000009', name: 'Meera Nair', gender: 'FEMALE' },
  { phone: '9200000010', name: 'Aditya Rao', gender: 'MALE' },
  { phone: '9200000011', name: 'Ishita Ghosh', gender: 'FEMALE' },
  { phone: '9200000012', name: 'Farhan Qureshi', gender: 'OTHER' },
  { phone: '9200000013', name: 'Divya Menon', gender: 'FEMALE' },
  { phone: '9200000014', name: 'Sameer Joshi', gender: null },
];

const DEVICES = [
  { type: 'MOBILE', weight: 72 },
  { type: 'DESKTOP', weight: 18 },
  { type: 'TABLET', weight: 7 },
  { type: 'OTHER', weight: 3 },
];

const FAILURE_REASONS = [
  'Provider timed out after 30000ms',
  'No person detected in the uploaded photo',
  'Garment image could not be fetched (404)',
  'Upstream model returned 503 — capacity exceeded',
  'Input image resolution too low (min 512x512)',
];

const FLAG_REASONS = [
  'Reported by shopper — output looked distorted',
  'Input photo violates the upload policy',
  'Under review: possible misuse of another person’s photo',
];

const SIZES = ['S', 'M', 'L', 'XL'];
const COLORS = ['Black', 'White', 'Navy', 'Olive', 'Maroon'];

function weightedPick<T extends { weight: number }>(items: T[], random: () => number): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

export async function seedTryOns(prisma: PrismaClient): Promise<void> {
  // Runs made by hand while testing are left alone; the demo set is only
  // generated once, when the table has no meaningful history yet.
  const existing = await prisma.tryOnHistory.count({
    where: { user: { phone: { in: SHOPPERS.map((s) => s.phone) } } },
  });
  if (existing > 0) {
    console.log(`[seed] Try-on demo history already present (${existing} runs) — skipping.`);
    return;
  }

  const settingRow = await prisma.platformSetting.findUnique({ where: { key: 'tryonMinPricePaise' } });
  const minPricePaise = (settingRow?.value as number | undefined) ?? 200000;

  // Only products the storefront would actually allow a try-on for.
  const products = await prisma.product.findMany({
    where: { status: 'APPROVED', basePricePaise: { gte: minPricePaise } },
    orderBy: { soldCount: 'desc' },
    take: 60,
    select: {
      id: true,
      title: true,
      images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
    },
  });
  if (products.length === 0) {
    console.log('[seed] No try-on eligible products — skipping try-on seed.');
    return;
  }

  const users = [];
  for (let i = 0; i < SHOPPERS.length; i += 1) {
    const s = SHOPPERS[i];
    users.push(
      await prisma.user.upsert({
        where: { phone: s.phone },
        update: { gender: s.gender },
        create: {
          phone: s.phone,
          name: s.name,
          gender: s.gender,
          role: Role.CUSTOMER,
          referralCode: generateReferralCode(),
          tryOnPhotoUrl: `https://picsum.photos/seed/clowe-person-${i}/480/640`,
        },
      }),
    );
  }

  const random = makeRandom(20260803);
  const now = new Date();
  const rows: {
    userId: string;
    productId: string;
    inputImageUrl: string;
    resultImageUrl: string | null;
    provider: string;
    status: TryOnStatus;
    costPaise: number;
    errorMessage: string | null;
    feedback: string | null;
    variantSize: string;
    variantColor: string;
    durationMs: number;
    deviceType: string;
    flagged: boolean;
    flagReason: string | null;
    flaggedAt: Date | null;
    createdAt: Date;
  }[] = [];

  for (let dayOffset = DAYS - 1; dayOffset >= 0; dayOffset -= 1) {
    // Usage grows slowly over the window, with a weekend bump.
    const date = new Date(now);
    date.setDate(date.getDate() - dayOffset);
    const growth = 1 + (DAYS - dayOffset) / DAYS;
    const weekend = date.getDay() === 0 || date.getDay() === 6 ? 1.3 : 1;
    const base = RUNS_PER_DAY_MIN + random() * (RUNS_PER_DAY_MAX - RUNS_PER_DAY_MIN);
    const runs = Math.max(1, Math.round((base * growth * weekend) / 2));

    for (let i = 0; i < runs; i += 1) {
      // Power users run more try-ons than the tail.
      const userIndex = Math.floor(random() ** 2 * users.length);
      const user = users[userIndex];
      const product = products[Math.floor(random() * products.length)];

      const createdAt = new Date(date);
      createdAt.setHours(9 + Math.floor(random() * 14), Math.floor(random() * 60), 0, 0);

      // Only settled runs are seeded — a PENDING row older than two minutes
      // is what the monitor's queue health check treats as stuck, and demo
      // data should not make a healthy platform look degraded.
      const status: TryOnStatus = random() < 0.055 ? TryOnStatus.FAILED : TryOnStatus.SUCCESS;
      const ok = status === TryOnStatus.SUCCESS;

      // 3–8s typical, with an occasional slow run.
      const durationMs = Math.round(
        (random() < 0.08 ? 12000 + random() * 9000 : 3000 + random() * 5000) *
          (status === TryOnStatus.FAILED ? 1.6 : 1),
      );

      const rated = ok && random() < 0.42;
      const flagged = random() < 0.012;

      rows.push({
        userId: user.id,
        productId: product.id,
        inputImageUrl: user.tryOnPhotoUrl ?? `https://picsum.photos/seed/clowe-person-x/480/640`,
        resultImageUrl: ok ? (product.images[0]?.url ?? null) : null,
        provider: random() < 0.82 ? 'mock' : 'fashn',
        status,
        costPaise: ok && random() < 0.18 ? 650 : 0,
        errorMessage:
          status === TryOnStatus.FAILED
            ? FAILURE_REASONS[Math.floor(random() * FAILURE_REASONS.length)]
            : null,
        feedback: rated ? (random() < 0.78 ? 'UP' : 'DOWN') : null,
        variantSize: SIZES[Math.floor(random() * SIZES.length)],
        variantColor: COLORS[Math.floor(random() * COLORS.length)],
        durationMs,
        deviceType: weightedPick(DEVICES, random).type,
        flagged,
        flagReason: flagged ? FLAG_REASONS[Math.floor(random() * FLAG_REASONS.length)] : null,
        flaggedAt: flagged ? createdAt : null,
        createdAt,
      });
    }
  }

  await prisma.tryOnHistory.createMany({ data: rows });
  console.log(
    `[seed] Try-on history ready: ${rows.length} runs across ${users.length} shoppers / ${products.length} products`,
  );
}
