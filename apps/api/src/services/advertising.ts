import type { AdCampaign, Prisma } from '@prisma/client';
import {
  adMetrics,
  CPC_AD_TYPE_LABELS,
  PLACEMENT_LABELS,
  PLACEMENT_SPACE,
  type AdCampaignRow,
  type AdLabel,
  type AdServeBanner,
  type AdServeItem,
  type AdServeResponse,
  type AdSurface,
  type AdsOverview,
  type CpcAdType,
  type PlacementKind,
  type SlotAvailability,
} from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { productListItemInclude, toProductListItem } from '../utils/productListing';
import { getCommercial } from './commercial';
import { planOf } from './planService';
import { visibleProductWhere } from './shopperVisibility';
import { chargeSeller, grantAdCredit, refundCharge, walletView } from './wallet';

// ---------------------------------------------------------------------------
// Advertising and sponsorship (owner's Batch 2).
//
// Serving: each surface has labelled slots, filled by the highest bids among
// campaigns that are running, inside their budgets, on live products. Paid
// items never enter organic results or their ranking.
//
// A click is valid once per shopper (or device), campaign and product in 24
// hours; never the seller's own; never a bot. A valid CPC click charges the
// bid (advertising credit first, then the wallet, then the next payout) and
// stops serving once the daily or monthly budget is reached. An order within
// attributionDays of a valid click on that product is attributed to the ad.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|curl|wget|python-requests|axios/i;

/** India-time calendar day of an instant, as a DATE-column value. */
export function istDay(at: Date): Date {
  const ist = new Date(at.getTime() + 5.5 * 3_600_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}
const istDayStr = (d: Date) => d.toISOString().slice(0, 10);
/** Midnight India time at the start of a YYYY-MM-DD day. */
const istMidnight = (date: string) => new Date(new Date(`${date}T00:00:00Z`).getTime() - 5.5 * 3_600_000);

/** Which CPC types a surface serves, in its two slots. */
const SURFACE_TYPES: Record<AdSurface, { top: CpcAdType[]; row: CpcAdType[] }> = {
  SEARCH: { top: ['TOP_SEARCH'], row: ['SPONSORED_PRODUCT', 'AI_SEARCH_BOOST'] },
  CATEGORY: { top: [], row: ['CATEGORY_PROMOTION', 'SPONSORED_PRODUCT'] },
  PRODUCT: { top: [], row: ['AI_RECOMMENDATION_BOOST'] },
  HOME: { top: [], row: ['SPIN360_PROMOTION'] },
  TRYON: { top: [], row: ['TRYON_PROMOTION'] },
  // The compare page: products like the ones being compared.
  COMPARE: { top: [], row: ['COMPARE_PROMOTION'] },
};
/** Which booked placements a surface shows. */
const SURFACE_PLACEMENTS: Record<AdSurface, PlacementKind[]> = {
  SEARCH: [],
  CATEGORY: ['CATEGORY_BANNER', 'SP_CATEGORY_TOP'],
  PRODUCT: [],
  HOME: ['HOMEPAGE_BANNER', 'SP_HOMEPAGE_BANNER', 'SP_HOMEPAGE_FEATURED', 'FEATURED_SELLER', 'FLASH_SALE', 'NEW_COLLECTION', 'SP_BRAND_SPOTLIGHT', 'SP_FESTIVAL_CAMPAIGN', 'SP_BASIC_PRODUCT'],
  TRYON: [],
  COMPARE: [],
};
const ROW_SIZE = 4;

async function bumpStat(campaignId: string, slotType: string, at: Date, data: { impressions?: number; clicks?: number; spendPaise?: number; orders?: number; revenuePaise?: number }) {
  const day = istDay(at);
  await prisma.adDailyStat.upsert({
    where: { campaignId_day_slotType: { campaignId, day, slotType } },
    create: { campaignId, day, slotType, impressions: data.impressions ?? 0, clicks: data.clicks ?? 0, spendPaise: data.spendPaise ?? 0, orders: data.orders ?? 0, revenuePaise: data.revenuePaise ?? 0 },
    update: {
      impressions: { increment: data.impressions ?? 0 },
      clicks: { increment: data.clicks ?? 0 },
      spendPaise: { increment: data.spendPaise ?? 0 },
      orders: { increment: data.orders ?? 0 },
      revenuePaise: { increment: data.revenuePaise ?? 0 },
    },
  });
}

/** Spend today and this month (India time). */
async function spendOf(campaignIds: string[], now: Date): Promise<Map<string, { today: number; month: number }>> {
  const today = istDay(now);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const rows = await prisma.adDailyStat.groupBy({
    by: ['campaignId', 'day'],
    where: { campaignId: { in: campaignIds }, day: { gte: monthStart } },
    _sum: { spendPaise: true },
  });
  const out = new Map<string, { today: number; month: number }>();
  for (const r of rows) {
    const cur = out.get(r.campaignId) ?? { today: 0, month: 0 };
    cur.month += r._sum.spendPaise ?? 0;
    if (r.day.getTime() === today.getTime()) cur.today += r._sum.spendPaise ?? 0;
    out.set(r.campaignId, cur);
  }
  return out;
}

/**
 * A smart campaign's bid for a type, inside the type's range: a goal of
 * CLICKS bids low in the range (more clicks for the budget), ORDERS bids high
 * (the top positions, where shoppers buy).
 */
function smartBid(c: AdCampaign, type: CpcAdType, ranges: Partial<Record<CpcAdType, [number, number]>>): number {
  const [lo, hi] = ranges[type] ?? [0, 0];
  return Math.round(lo + (hi - lo) * (c.goal === 'ORDERS' ? 0.75 : 0.25));
}

/** Running, in its dates, approved, not paused, inside its budgets. */
function running(c: AdCampaign, now: Date, spend: { today: number; month: number } | undefined): boolean {
  if (c.status !== 'ACTIVE' || c.startAt > now || (c.endAt && c.endAt <= now)) return false;
  if (c.kind === 'CPC' || c.kind === 'SMART') {
    const s = spend ?? { today: 0, month: 0 };
    if (c.dailyBudgetPaise && s.today >= c.dailyBudgetPaise) return false;
    if (c.monthlyBudgetPaise && s.month >= c.monthlyBudgetPaise) return false;
    if (c.kind === 'SMART' && c.totalBudgetPaise && s.month >= c.totalBudgetPaise) return false;
  }
  return true;
}

/**
 * The ads for a surface. SEARCH matches the query's words in the title or
 * brand; CATEGORY the category; PRODUCT the product's category (another
 * product); HOME and TRYON anything live.
 */
export async function serveAds(surface: AdSurface, ctx: { q?: string; categoryId?: string; productId?: string }, now: Date = new Date()): Promise<AdServeResponse> {
  const c = await getCommercial();
  const visible = await visibleProductWhere();
  const types = SURFACE_TYPES[surface];
  const wanted = [...types.top, ...types.row].filter((t) => !c.ads.unavailableTypes.includes(t));
  let contextCategory: string | undefined = ctx.categoryId;
  if ((surface === 'PRODUCT' || surface === 'COMPARE') && ctx.productId) {
    contextCategory = (await prisma.product.findUnique({ where: { id: ctx.productId }, select: { categoryId: true } }))?.categoryId;
  }
  // A category page shows its subcategories' products too.
  const categoryIds = contextCategory
    ? [contextCategory, ...(await prisma.category.findMany({ where: { parentId: contextCategory }, select: { id: true } })).map((x) => x.id)]
    : [];
  const words = (ctx.q ?? '').toLowerCase().split(/\s+/).filter((w) => w.length >= 3).slice(0, 5);
  const productWhere: Prisma.ProductWhereInput = {
    status: 'APPROVED',
    isVisible: true,
    seller: { vacationMode: false, status: 'APPROVED' },
    ...visible,
    ...(surface === 'SEARCH' && words.length
      ? { OR: words.flatMap((w) => [{ title: { contains: w, mode: 'insensitive' as const } }, { brand: { contains: w, mode: 'insensitive' as const } }]) }
      : {}),
    ...((surface === 'CATEGORY' || surface === 'PRODUCT' || surface === 'COMPARE') && contextCategory ? { categoryId: { in: categoryIds } } : {}),
    ...((surface === 'PRODUCT' || surface === 'COMPARE') && ctx.productId ? { id: { not: ctx.productId } } : {}),
    ...(surface === 'TRYON' ? { tryOnEnabled: true } : {}),
    ...(surface === 'HOME' && wanted.includes('SPIN360_PROMOTION') ? { spinImages: { isEmpty: false } } : {}),
  };
  if (surface === 'SEARCH' && words.length === 0) return { top: [], items: [], banners: [] };
  if ((surface === 'CATEGORY' || surface === 'PRODUCT' || surface === 'COMPARE') && !contextCategory) return { top: [], items: [], banners: [] };

  const campaigns = wanted.length
    ? await prisma.adCampaign.findMany({
        where: { kind: { in: ['CPC', 'SMART', 'PACKAGE'] }, status: 'ACTIVE', startAt: { lte: now }, OR: [{ endAt: null }, { endAt: { gt: now } }], adTypes: { hasSome: wanted }, product: productWhere },
        include: { product: { include: productListItemInclude } },
      })
    : [];
  const spend = await spendOf(campaigns.map((x) => x.id), now);
  const live = campaigns.filter((x) => running(x, now, spend.get(x.id)) && x.product);
  // Each campaign competes in each slot type it runs, by its bid (packages and
  // smart campaigns bid on the seller's behalf); one card per product per slot.
  const bidFor = (x: (typeof live)[number], t: CpcAdType) =>
    x.kind === 'PACKAGE' ? (c.ads.cpcRanges[t]?.[1] ?? 0) : x.kind === 'SMART' ? smartBid(x, t, c.ads.cpcRanges) : (x.bidPaise ?? 0);
  const fill = (slotTypes: CpcAdType[], take: number, skip: Set<string>): AdServeItem[] => {
    const offers = live
      .flatMap((x) => slotTypes.filter((t) => x.adTypes.includes(t)).map((t) => ({ x, t, bid: bidFor(x, t) })))
      .sort((a, b) => b.bid - a.bid);
    const out: AdServeItem[] = [];
    for (const o of offers) {
      if (out.length >= take) break;
      if (skip.has(o.x.productId!)) continue;
      skip.add(o.x.productId!);
      out.push({ campaignId: o.x.id, slotType: o.t, label: 'Sponsored', product: toProductListItem(o.x.product!) });
    }
    return out;
  };
  const used = new Set<string>();
  const top = fill(types.top, 1, used);
  const items = fill(types.row.filter((t) => wanted.includes(t)), ROW_SIZE, used);

  // Booked placements running today: creatives as banners, featured
  // products as cards in the labelled row (ahead of the CPC ones).
  const placements = SURFACE_PLACEMENTS[surface];
  const booked = placements.length
    ? await prisma.adCampaign.findMany({
        where: {
          kind: 'PLACEMENT',
          status: 'ACTIVE',
          placement: { in: placements },
          bookings: { some: { day: istDay(now), scopeKey: surface === 'CATEGORY' ? contextCategory! : '' } },
        },
        orderBy: { createdAt: 'asc' },
        include: { seller: { select: { slug: true } } },
      })
    : [];
  const bookedProducts = new Map(
    (
      await prisma.product.findMany({
        where: { id: { in: booked.flatMap((b) => (b.productId ? [b.productId] : [])) }, status: 'APPROVED', isVisible: true, seller: { vacationMode: false, status: 'APPROVED' }, ...visible },
        include: productListItemInclude,
      })
    ).map((p) => [p.id, p]),
  );
  const label = (b: { sponsorship: boolean }): AdLabel => (b.sponsorship ? 'Sponsored' : 'Ad');
  const banners: AdServeBanner[] = [];
  const featured: AdServeItem[] = [];
  for (const b of booked) {
    const p = b.productId ? bookedProducts.get(b.productId) : undefined;
    if (b.productId && !p) continue; // the product is no longer live
    if (b.creativeUrl) {
      banners.push({
        campaignId: b.id,
        slotType: b.placement!,
        label: label(b),
        creativeUrl: b.creativeUrl,
        headline: b.headline ?? PLACEMENT_LABELS[b.placement as PlacementKind],
        href: p ? `/products/${p.slug}` : b.seller.slug ? `/store/${b.seller.slug}` : '/',
      });
    } else if (p && !used.has(p.id)) {
      used.add(p.id);
      featured.push({ campaignId: b.id, slotType: b.placement!, label: label(b), product: toProductListItem(p) });
    }
  }
  const row = [...featured, ...items].slice(0, Math.max(ROW_SIZE, featured.length));

  // Premium's "featured placement" and "ranking boost": a labelled card from a
  // Premium seller fills a free place in the row — never the organic results.
  if (row.length < ROW_SIZE && (surface === 'SEARCH' || surface === 'CATEGORY')) {
    const premium = await prisma.product.findMany({
      where: { ...productWhere, id: { notIn: [...used] }, seller: { vacationMode: false, status: 'APPROVED', subscription: { plan: 'PREMIUM' } } },
      include: productListItemInclude,
      orderBy: { approvedAt: 'desc' },
      take: ROW_SIZE - row.length,
    });
    for (const p of premium) row.push({ campaignId: '', slotType: 'PREMIUM_FEATURED', label: 'Sponsored', product: toProductListItem(p) });
  }
  return { top, items: row, banners };
}

/** Impressions, counted per campaign, day and slot. */
export async function recordImpressions(items: { campaignId: string; slotType: string }[], now: Date = new Date()): Promise<void> {
  const ids = [...new Set(items.map((i) => i.campaignId))];
  const known = new Set((await prisma.adCampaign.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((c) => c.id));
  for (const i of items) if (known.has(i.campaignId)) await bumpStat(i.campaignId, i.slotType, now, { impressions: 1 });
}

export interface ClickOutcome {
  valid: boolean;
  reason: string | null;
  chargedPaise: number;
}

/** A click on an ad: validated, recorded, and for CPC charged the bid. */
export async function registerClick(input: {
  campaignId: string;
  productId?: string | null;
  deviceId: string;
  slotType: string;
  userId?: string | null;
  userAgent?: string | null;
  now?: Date;
}): Promise<ClickOutcome> {
  const now = input.now ?? new Date();
  const campaign = await prisma.adCampaign.findUnique({ where: { id: input.campaignId }, include: { seller: { select: { userId: true } } } });
  if (!campaign) throw ApiError.notFound('Ad not found');
  const viewerKey = input.userId ? `u:${input.userId}` : `d:${input.deviceId}`;
  const productId = input.productId ?? campaign.productId;
  let reason: string | null = null;
  if (!input.userAgent || BOT.test(input.userAgent)) reason = 'bot';
  else if (input.userId && input.userId === campaign.seller.userId) reason = 'own click';
  else {
    const recent = await prisma.adClick.findFirst({
      where: { campaignId: campaign.id, productId, valid: true, createdAt: { gt: new Date(now.getTime() - DAY_MS) }, OR: [{ viewerKey }, ...(input.userId ? [{ userId: input.userId }] : [])] },
    });
    if (recent) reason = 'repeat within 24 hours';
  }
  const valid = reason === null;
  const click = await prisma.adClick.create({ data: { campaignId: campaign.id, productId, viewerKey, userId: input.userId ?? null, valid, reason, createdAt: now } });
  if (!valid) return { valid, reason, chargedPaise: 0 };

  let charged = 0;
  if (campaign.kind === 'CPC' || campaign.kind === 'SMART') {
    const c = await getCommercial();
    const bid =
      campaign.kind === 'SMART'
        ? smartBid(campaign, input.slotType as CpcAdType, c.ads.cpcRanges)
        : campaign.sponsorship
          ? Math.round((campaign.bidPaise ?? 0) * (1 - (await sponsorshipDiscount(campaign.sellerId)) / 100))
          : (campaign.bidPaise ?? 0);
    if (bid > 0) {
      const r = await chargeSeller({
        sellerId: campaign.sellerId,
        type: campaign.sponsorship ? 'SPONSORSHIP_FEE' : 'AD_SPEND',
        basePaise: bid,
        note: `${campaign.sponsorship ? 'Sponsored product' : CPC_AD_TYPE_LABELS[input.slotType as CpcAdType] ?? 'Ad'} click — ${campaign.name}`,
        idempotencyKey: `click:${click.id}`,
        useAdCredit: !campaign.sponsorship,
      });
      charged = r.charged ? bid : 0;
      await prisma.adClick.update({ where: { id: click.id }, data: { chargedPaise: charged } });
    }
  }
  await bumpStat(campaign.id, input.slotType, now, { clicks: 1, spendPaise: charged });
  return { valid, reason, chargedPaise: charged };
}

/** Orders within attributionDays of a valid click on that product's ad. */
export async function attributeOrder(orderId: string): Promise<number> {
  const c = await getCommercial();
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order) return 0;
  let n = 0;
  for (const item of order.items) {
    const click = await prisma.adClick.findFirst({
      where: { userId: order.userId, productId: item.productId, valid: true, createdAt: { gt: new Date(order.createdAt.getTime() - c.ads.attributionDays * DAY_MS), lte: order.createdAt } },
      orderBy: { createdAt: 'desc' },
    });
    if (!click) continue;
    const revenue = item.pricePaise * item.quantity - item.promoDiscountPaise;
    const created = await prisma.adAttribution.createMany({ data: [{ campaignId: click.campaignId, clickId: click.id, orderItemId: item.id, revenuePaise: revenue }], skipDuplicates: true });
    if (created.count) {
      await bumpStat(click.campaignId, 'ORDER', order.createdAt, { orders: 1, revenuePaise: revenue });
      n += 1;
    }
  }
  return n;
}

async function sponsorshipDiscount(sellerId: string): Promise<number> {
  const c = await getCommercial();
  return (await planOf(sellerId)) === 'PREMIUM' ? c.sponsorship.premiumDiscountPercent : 0;
}

async function ownLiveProduct(sellerId: string, productId: string) {
  const p = await prisma.product.findFirst({ where: { id: productId, sellerId }, select: { id: true, title: true, status: true } });
  if (!p) throw ApiError.notFound('Product not found');
  if (p.status !== 'APPROVED') throw ApiError.badRequest('Only a live product can be advertised', 'PRODUCT_NOT_LIVE');
  return p;
}

/** A pay-per-click campaign (advertising, or sponsorship's per-click Sponsored Product). */
export async function createCpcCampaign(sellerId: string, input: {
  name: string;
  adTypes: CpcAdType[];
  productId: string;
  bidPaise: number;
  dailyBudgetPaise: number;
  monthlyBudgetPaise?: number;
  sponsorship?: boolean;
  startDate?: string;
  endDate?: string;
}) {
  const c = await getCommercial();
  await ownLiveProduct(sellerId, input.productId);
  for (const t of input.adTypes) {
    if (c.ads.unavailableTypes.includes(t)) throw ApiError.badRequest(`${CPC_AD_TYPE_LABELS[t]} is not available yet`, 'AD_TYPE_UNAVAILABLE');
  }
  const [lo, hi] = input.sponsorship
    ? c.sponsorship.perClickRangePaise
    : input.adTypes.reduce<[number, number]>((r, t) => [Math.max(r[0], c.ads.cpcRanges[t]![0]), Math.min(r[1], c.ads.cpcRanges[t]![1])], [0, Number.MAX_SAFE_INTEGER]);
  if (input.bidPaise < lo || input.bidPaise > hi) {
    throw ApiError.invalidField('bidPaise', `Bid between ₹${lo / 100} and ₹${hi / 100} per click for ${input.sponsorship ? 'Sponsored Product sponsorship' : 'these ad types'}`, 'BID_OUT_OF_RANGE');
  }
  return prisma.adCampaign.create({
    data: {
      sellerId,
      kind: 'CPC',
      sponsorship: !!input.sponsorship,
      name: input.name,
      adTypes: input.sponsorship ? ['SPONSORED_PRODUCT'] : input.adTypes,
      productId: input.productId,
      bidPaise: input.bidPaise,
      dailyBudgetPaise: input.dailyBudgetPaise,
      monthlyBudgetPaise: input.monthlyBudgetPaise ?? null,
      status: 'ACTIVE',
      startAt: input.startDate ? istMidnight(input.startDate) : new Date(),
      endAt: input.endDate ? istMidnight(input.endDate) : null,
    },
  });
}

/** Smart Campaign: a budget and a goal, spread over the available CPC types by how they perform. */
export async function createSmartCampaign(sellerId: string, input: { name: string; productId: string; totalBudgetPaise: number; days: number; goal: 'CLICKS' | 'ORDERS' }) {
  const c = await getCommercial();
  await ownLiveProduct(sellerId, input.productId);
  const types = (Object.keys(c.ads.cpcRanges) as CpcAdType[]).filter((t) => !c.ads.unavailableTypes.includes(t));
  const now = new Date();
  return prisma.adCampaign.create({
    data: {
      sellerId,
      kind: 'SMART',
      name: input.name,
      adTypes: types,
      productId: input.productId,
      goal: input.goal,
      totalBudgetPaise: input.totalBudgetPaise,
      dailyBudgetPaise: Math.ceil(input.totalBudgetPaise / input.days),
      monthlyBudgetPaise: input.totalBudgetPaise,
      status: 'ACTIVE',
      startAt: now,
      endAt: new Date(now.getTime() + input.days * DAY_MS),
    },
  });
}

function placementRules(c: Awaited<ReturnType<typeof getCommercial>>, placement: PlacementKind) {
  const rules = c.ads.placements[placement];
  if (!rules) throw ApiError.badRequest('This placement is not offered', 'PLACEMENT_UNAVAILABLE');
  return rules;
}

/** Free slots of a space for each day. */
async function freeSlots(space: string, scopeKey: string, days: Date[], slots: number): Promise<Map<string, number[]>> {
  const taken = await prisma.adSlotBooking.findMany({ where: { space, scopeKey, day: { in: days } }, select: { day: true, slot: true } });
  const out = new Map<string, number[]>();
  for (const d of days) {
    const used = new Set(taken.filter((t) => t.day.getTime() === d.getTime()).map((t) => t.slot));
    out.set(istDayStr(d), Array.from({ length: slots }, (_, i) => i).filter((i) => !used.has(i)));
  }
  return out;
}

export async function availability(placement: PlacementKind, from: string, days: number, categoryId?: string): Promise<SlotAvailability> {
  const c = await getCommercial();
  const rules = placementRules(c, placement);
  const start = new Date(`${from}T00:00:00Z`);
  const list = Array.from({ length: Math.min(days, 92) }, (_, i) => new Date(start.getTime() + i * DAY_MS));
  const scopeKey = PLACEMENT_SPACE[placement].startsWith('CATEGORY') ? (categoryId ?? '') : '';
  const free = await freeSlots(PLACEMENT_SPACE[placement], scopeKey, list, rules.slots);
  return { placement, days: list.map((d) => ({ date: istDayStr(d), free: free.get(istDayStr(d))!.length, slots: rules.slots })) };
}

/**
 * Book a placement (advertising or sponsorship): every day of it on the
 * calendar, one slot each, all or nothing — two bookings cannot hold the same
 * slot. Charged at booking; a creative waits for approval and is refunded if
 * rejected.
 */
export async function bookPlacement(sellerId: string, input: {
  placement: PlacementKind;
  startDate: string;
  units: number;
  categoryId?: string;
  productId?: string;
  creativeUrl?: string;
  headline?: string;
  packageKey?: string;
  chargePaise?: number;
}) {
  const c = await getCommercial();
  const rules = placementRules(c, input.placement);
  if (input.productId) await ownLiveProduct(sellerId, input.productId);
  const space = PLACEMENT_SPACE[input.placement];
  const scopeKey = space.startsWith('CATEGORY') ? (input.categoryId ?? '') : '';
  if (space.startsWith('CATEGORY') && !input.categoryId) throw ApiError.badRequest('Pick the category for this placement', 'CATEGORY_REQUIRED');
  if (rules.needsCreative && !input.creativeUrl) throw ApiError.badRequest('Add the banner image for this placement', 'CREATIVE_REQUIRED');
  if (!rules.needsCreative && !input.productId) throw ApiError.badRequest('Pick the product to feature', 'PRODUCT_REQUIRED');
  const dayCount = rules.unit === 'DAY' ? input.units : rules.unit === 'WEEK' ? input.units * 7 : c.ads.campaignDays;
  const first = new Date(`${input.startDate}T00:00:00Z`);
  if (first < istDay(new Date())) throw ApiError.badRequest('Start today or later', 'START_IN_PAST');
  const days = Array.from({ length: dayCount }, (_, i) => new Date(first.getTime() + i * DAY_MS));
  const base =
    input.chargePaise ??
    Math.round((rules.unit === 'CAMPAIGN' ? rules.pricePaise : rules.pricePaise * input.units) * (1 - (rules.sponsorship ? await sponsorshipDiscount(sellerId) : 0) / 100));
  const startAt = istMidnight(input.startDate);
  const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.adCampaign.create({
      data: {
        sellerId,
        kind: 'PLACEMENT',
        sponsorship: rules.sponsorship,
        name: `${PLACEMENT_LABELS[input.placement]} from ${input.startDate}`,
        placement: input.placement,
        packageKey: input.packageKey ?? null,
        categoryId: input.categoryId ?? null,
        productId: input.productId ?? null,
        creativeUrl: input.creativeUrl ?? null,
        headline: input.headline ?? null,
        pricePaise: base,
        status: rules.needsCreative ? 'PENDING_APPROVAL' : 'ACTIVE',
        startAt,
        endAt: new Date(startAt.getTime() + dayCount * DAY_MS),
      },
    });
    for (const day of days) {
      const taken = await tx.adSlotBooking.findMany({ where: { space, scopeKey, day }, select: { slot: true } });
      const usedSlots = new Set(taken.map((t) => t.slot));
      const slot = Array.from({ length: rules.slots }, (_, i) => i).find((i) => !usedSlots.has(i));
      if (slot === undefined) throw ApiError.badRequest(`${PLACEMENT_LABELS[input.placement]} is fully booked on ${istDayStr(day)}`, 'SLOT_TAKEN');
      // The unique (space, scope, day, slot) key turns a race into a refusal, never a double booking.
      await tx.adSlotBooking.create({ data: { campaignId: created.id, space, scopeKey, day, slot } });
    }
    return created;
  }).catch((err: unknown) => {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002') {
      throw ApiError.badRequest('That slot was just booked — pick other dates', 'SLOT_TAKEN');
    }
    throw err;
  });
  if (base > 0) {
    await chargeSeller({
      sellerId,
      type: rules.sponsorship ? 'SPONSORSHIP_FEE' : 'AD_SPEND',
      basePaise: base,
      note: `${PLACEMENT_LABELS[input.placement]} — ${dayCount} day${dayCount === 1 ? '' : 's'} from ${input.startDate}`,
      idempotencyKey: `booking:${campaign.id}`,
      useAdCredit: !rules.sponsorship,
    });
    await bumpStat(campaign.id, input.placement, startAt, { spendPaise: base });
  }
  if (rules.needsCreative) await notifyAdmins(`Ad creative to review — ${PLACEMENT_LABELS[input.placement]}`, campaign.name);
  return campaign;
}

/** A fixed package: its ad types for campaignDays, and any placement it includes. */
export async function buyPackage(sellerId: string, input: { package: string; productId: string; startDate: string; creativeUrl?: string; headline?: string }) {
  const c = await getCommercial();
  const pkg = c.ads.packages[input.package as keyof typeof c.ads.packages];
  if (!pkg) throw ApiError.badRequest('Unknown package');
  if (input.package === 'ENTERPRISE') throw ApiError.badRequest('Enterprise is set up with vendor support — use the Contact vendor support button', 'CONTACT_SUPPORT');
  await ownLiveProduct(sellerId, input.productId);
  const startAt = istMidnight(input.startDate);
  const campaign = await prisma.adCampaign.create({
    data: {
      sellerId,
      kind: 'PACKAGE',
      name: `${input.package[0]}${input.package.slice(1).toLowerCase()} package from ${input.startDate}`,
      packageKey: input.package,
      adTypes: pkg.types.filter((t) => !c.ads.unavailableTypes.includes(t)),
      productId: input.productId,
      pricePaise: pkg.pricePaise,
      status: 'ACTIVE',
      startAt,
      endAt: new Date(startAt.getTime() + c.ads.campaignDays * DAY_MS),
    },
  });
  // Its placements (Luxury's homepage placement) are booked for the same days, paid within the package.
  try {
    for (const placement of pkg.placements) {
      await bookPlacement(sellerId, {
        placement,
        startDate: input.startDate,
        units: placementRules(c, placement).unit === 'DAY' ? c.ads.campaignDays : 1,
        productId: input.productId,
        creativeUrl: input.creativeUrl,
        headline: input.headline,
        packageKey: input.package,
        chargePaise: 0,
      });
    }
  } catch (err) {
    await prisma.adCampaign.delete({ where: { id: campaign.id } });
    throw err;
  }
  await chargeSeller({ sellerId, type: 'AD_SPEND', basePaise: pkg.pricePaise, note: `${campaign.name}`, idempotencyKey: `package:${campaign.id}`, useAdCredit: true });
  await bumpStat(campaign.id, input.package, startAt, { spendPaise: pkg.pricePaise });
  return campaign;
}

async function notifyAdmins(title: string, body: string) {
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
  await prisma.notification.createMany({ data: admins.map((a) => ({ userId: a.id, type: 'AD_REVIEW', title, body, linkHref: '/admin/ads' })) });
}

/** Admin: approve a creative (it goes live on its dates), or reject it (slots freed, money back). */
export async function reviewCampaign(campaignId: string, action: 'approve' | 'reject', reason?: string) {
  const campaign = await prisma.adCampaign.findUnique({ where: { id: campaignId }, include: { seller: { select: { userId: true } } } });
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (campaign.status !== 'PENDING_APPROVAL') throw ApiError.badRequest('This campaign is not waiting for review', 'NOT_PENDING');
  if (action === 'approve') {
    await prisma.adCampaign.update({ where: { id: campaignId }, data: { status: 'ACTIVE' } });
  } else {
    if (!reason || reason.trim().length < 3) throw ApiError.badRequest('Say why it is rejected — the seller sees it');
    await prisma.$transaction([
      prisma.adCampaign.update({ where: { id: campaignId }, data: { status: 'REJECTED', rejectionReason: reason } }),
      prisma.adSlotBooking.deleteMany({ where: { campaignId } }),
    ]);
    await refundCharge(`booking:${campaignId}`, `${campaign.name} not approved`);
  }
  await prisma.notification.create({
    data: {
      userId: campaign.seller.userId,
      type: 'AD_REVIEW',
      title: action === 'approve' ? `Approved: ${campaign.name}` : `Not approved: ${campaign.name}`,
      body: action === 'approve' ? 'Your creative is approved and runs on its dates.' : `${reason} The slots are freed and the charge is refunded.`,
      linkHref: '/seller/advertising',
    },
  });
}

/** The seller's controls: pause, resume, edit the bid or budgets (inside the range). */
export async function updateCampaign(sellerId: string, id: string, input: { status?: 'ACTIVE' | 'PAUSED'; name?: string; bidPaise?: number; dailyBudgetPaise?: number; monthlyBudgetPaise?: number | null }) {
  const campaign = await prisma.adCampaign.findFirst({ where: { id, sellerId } });
  if (!campaign) throw ApiError.notFound('Campaign not found');
  if (campaign.status === 'ENDED' || campaign.status === 'REJECTED' || campaign.status === 'PENDING_APPROVAL') {
    throw ApiError.badRequest('This campaign cannot be changed now', 'CAMPAIGN_CLOSED');
  }
  if (input.bidPaise !== undefined) {
    if (campaign.kind !== 'CPC') throw ApiError.badRequest('Only a pay-per-click campaign has a bid');
    const c = await getCommercial();
    const [lo, hi] = campaign.sponsorship
      ? c.sponsorship.perClickRangePaise
      : (campaign.adTypes as CpcAdType[]).reduce<[number, number]>((r, t) => [Math.max(r[0], c.ads.cpcRanges[t]![0]), Math.min(r[1], c.ads.cpcRanges[t]![1])], [0, Number.MAX_SAFE_INTEGER]);
    if (input.bidPaise < lo || input.bidPaise > hi) throw ApiError.invalidField('bidPaise', `Bid between ₹${lo / 100} and ₹${hi / 100}`, 'BID_OUT_OF_RANGE');
  }
  return prisma.adCampaign.update({
    where: { id },
    data: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.bidPaise !== undefined ? { bidPaise: input.bidPaise } : {}),
      ...(input.dailyBudgetPaise !== undefined ? { dailyBudgetPaise: input.dailyBudgetPaise } : {}),
      ...(input.monthlyBudgetPaise !== undefined ? { monthlyBudgetPaise: input.monthlyBudgetPaise } : {}),
    },
  });
}

/** Campaigns past their end date are ENDED. */
export async function endExpiredCampaigns(now: Date = new Date()): Promise<number> {
  const r = await prisma.adCampaign.updateMany({ where: { status: { in: ['ACTIVE', 'PAUSED'] }, endAt: { lte: now } }, data: { status: 'ENDED' } });
  return r.count;
}

export function startAdJobs(): void {
  const run = () => void endExpiredCampaigns().catch((err) => console.error('[clowe-api] ad expiry failed:', err));
  run();
  const timer = setInterval(run, 15 * 60 * 1000);
  timer.unref();
}

/** The seller's advertising and sponsorship dashboard. */
export async function adsOverview(sellerId: string, sponsorship?: boolean): Promise<AdsOverview> {
  const campaigns = await prisma.adCampaign.findMany({
    where: { sellerId, ...(sponsorship === undefined ? {} : { sponsorship }) },
    orderBy: { createdAt: 'desc' },
    include: { product: { select: { title: true } } },
  });
  const ids = campaigns.map((c) => c.id);
  const stats = ids.length ? await prisma.adDailyStat.findMany({ where: { campaignId: { in: ids } } }) : [];
  const zero = { impressions: 0, clicks: 0, orders: 0, spendPaise: 0, revenuePaise: 0 };
  const add = (a: typeof zero, s: typeof zero) => ({ impressions: a.impressions + s.impressions, clicks: a.clicks + s.clicks, orders: a.orders + s.orders, spendPaise: a.spendPaise + s.spendPaise, revenuePaise: a.revenuePaise + s.revenuePaise });
  const byCampaign = new Map<string, typeof zero>();
  const byType = new Map<string, typeof zero>();
  let totals = zero;
  for (const s of stats) {
    const v = { impressions: s.impressions, clicks: s.clicks, orders: s.orders, spendPaise: s.spendPaise, revenuePaise: s.revenuePaise };
    byCampaign.set(s.campaignId, add(byCampaign.get(s.campaignId) ?? zero, v));
    if (s.slotType && s.slotType !== 'ORDER') byType.set(s.slotType, add(byType.get(s.slotType) ?? zero, v));
    totals = add(totals, v);
  }
  const rows: AdCampaignRow[] = campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    sponsorship: c.sponsorship,
    adTypes: c.adTypes as CpcAdType[],
    placement: (c.placement as PlacementKind | null) ?? null,
    packageKey: c.packageKey,
    status: c.status,
    rejectionReason: c.rejectionReason,
    productTitle: c.product?.title ?? null,
    bidPaise: c.bidPaise,
    dailyBudgetPaise: c.dailyBudgetPaise,
    monthlyBudgetPaise: c.monthlyBudgetPaise,
    pricePaise: c.pricePaise,
    startAt: c.startAt.toISOString(),
    endAt: c.endAt?.toISOString() ?? null,
    metrics: adMetrics(byCampaign.get(c.id) ?? zero),
  }));
  const wallet = await walletView(sellerId);
  return {
    totals: adMetrics(totals),
    byType: [...byType.entries()].map(([slotType, v]) => ({ slotType, ...adMetrics(v) })),
    campaigns: rows,
    adCreditPaise: wallet.adCreditPaise,
    walletPaise: wallet.walletPaise,
  };
}

/**
 * The ₹500 welcome advertising credit (an admin setting), once per seller:
 * at approval, and for sellers approved before advertising existed, the
 * first time they open Advertising.
 */
export async function grantWelcomeCredit(sellerId: string): Promise<boolean> {
  const seller = await prisma.sellerProfile.findUnique({ where: { id: sellerId }, select: { status: true } });
  if (seller?.status !== 'APPROVED') return false;
  const c = await getCommercial();
  return grantAdCredit(sellerId, c.ads.welcomeCreditPaise, 'Welcome advertising credit', `welcome-credit:${sellerId}`);
}
