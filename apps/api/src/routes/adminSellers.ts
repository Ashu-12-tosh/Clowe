import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  ADMIN_SELLER_SORTS,
  KYC_CHECK_TYPES,
  KYC_STATUSES,
  KYC_STATUS_LABELS,
  SELLER_STATUSES,
  SELLER_STATUS_LABELS,
  adminSellerActionSchema,
  adminSellerKycSchema,
  adminSellerNoteSchema,
  kycApprovalWarnings,
  panGstinMismatch,
  type AdminSellerDetail,
  type AdminSellerListRow,
  type AdminSellerPage,
  type AdminSellerSort,
  type AdminSellerStatus,
  type AdminSellerSummary,
  type KycStatus,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { sendToUserSafe } from '../services/messaging';
import { kycAdminRunLimiter } from '../middleware/rateLimits';
import {
  KycCheckRunningError,
  getSellerKycSummary,
  runSellerKyc,
  sellersWithFraudFlag,
} from '../services/kyc/sellerKyc';

export const adminSellersRouter = Router();
adminSellersRouter.use(requireAuth, requireRole('ADMIN'));

/** Marketplace-wide seller count is modest; rank in memory for GMV sorts. */
const SCAN_CAP = 5000;
const GROWTH_DAYS = 30;

const listQuery = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(['ALL', ...SELLER_STATUSES]).default('ALL'),
  kyc: z.enum(['ALL', ...KYC_STATUSES]).default('ALL'),
  city: z.string().trim().optional(),
  sort: z.enum(ADMIN_SELLER_SORTS).default('NEWEST'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(10),
});

const SELLER_INCLUDE = {
  user: { select: { id: true, name: true, phone: true, email: true } },
  _count: { select: { products: true } },
} satisfies Prisma.SellerProfileInclude;

type SellerRecord = Prisma.SellerProfileGetPayload<{ include: typeof SELLER_INCLUDE }>;

/** Per-seller sales, computed once and reused across list and summary. */
interface SalesRollup {
  orderCount: number;
  gmvMonthPaise: number;
  gmvTotalPaise: number;
  unitsSold: number;
  returnedUnits: number;
  cancelledUnits: number;
  categoryGmv: Map<string, { name: string; gmvPaise: number }>;
}

async function salesBySeller(): Promise<Map<string, SalesRollup>> {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const items = await prisma.orderItem.findMany({
    where: { order: { status: { not: 'PLACED' } } },
    select: {
      sellerId: true,
      orderId: true,
      status: true,
      quantity: true,
      pricePaise: true,
      order: { select: { createdAt: true } },
      product: { select: { category: { select: { id: true, name: true } } } },
    },
  });

  const map = new Map<string, SalesRollup>();
  const orderSets = new Map<string, Set<string>>();
  for (const item of items) {
    const roll =
      map.get(item.sellerId) ??
      ({
        orderCount: 0,
        gmvMonthPaise: 0,
        gmvTotalPaise: 0,
        unitsSold: 0,
        returnedUnits: 0,
        cancelledUnits: 0,
        categoryGmv: new Map(),
      } satisfies SalesRollup);

    const line = item.pricePaise * item.quantity;
    const counts = !['CANCELLED', 'RETURNED'].includes(item.status);
    if (counts) {
      roll.gmvTotalPaise += line;
      roll.unitsSold += item.quantity;
      if (item.order.createdAt >= monthStart) roll.gmvMonthPaise += line;
      const cat = item.product.category;
      const entry = roll.categoryGmv.get(cat.id) ?? { name: cat.name, gmvPaise: 0 };
      entry.gmvPaise += line;
      roll.categoryGmv.set(cat.id, entry);
    }
    if (item.status === 'RETURNED' || item.status === 'RETURN_REQUESTED') {
      roll.returnedUnits += item.quantity;
    }
    if (item.status === 'CANCELLED') roll.cancelledUnits += item.quantity;

    const seen = orderSets.get(item.sellerId) ?? new Set<string>();
    seen.add(item.orderId);
    orderSets.set(item.sellerId, seen);
    map.set(item.sellerId, roll);
  }

  for (const [sellerId, seen] of orderSets) {
    const roll = map.get(sellerId);
    if (roll) roll.orderCount = seen.size;
  }
  return map;
}

/** SEL-XXXXXX — readable reference derived from the row's own id. */
function sellerReference(id: string): string {
  return `SEL-${id.slice(-6).toUpperCase()}`;
}

function toRow(
  seller: SellerRecord,
  sales: SalesRollup | undefined,
  liveProducts: number,
  ratingAvg: number | null,
): AdminSellerListRow {
  const topCategory = sales
    ? [...sales.categoryGmv.values()].sort((a, b) => b.gmvPaise - a.gmvPaise)[0]?.name ?? null
    : null;
  return {
    id: seller.id,
    sellerId: sellerReference(seller.id),
    shopName: seller.shopName,
    ownerName: seller.user.name,
    email: seller.user.email,
    phone: seller.user.phone,
    businessType: seller.businessType,
    status: seller.status as AdminSellerStatus,
    statusLabel: SELLER_STATUS_LABELS[seller.status as AdminSellerStatus],
    kycStatus: seller.kycStatus as KycStatus,
    kycLabel: KYC_STATUS_LABELS[seller.kycStatus as KycStatus],
    city: seller.city,
    state: seller.state,
    primaryCategory: topCategory,
    joinedAt: seller.createdAt.toISOString(),
    productCount: seller._count.products,
    liveProductCount: liveProducts,
    orderCount: sales?.orderCount ?? 0,
    gmvMonthPaise: sales?.gmvMonthPaise ?? 0,
    gmvTotalPaise: sales?.gmvTotalPaise ?? 0,
    ratingAvg,
    suspensionReason: seller.suspensionReason,
    rejectionReason: seller.rejectionReason,
    kycAlerts: {
      panGstinMismatch: panGstinMismatch(seller.panNumber, seller.gstNumber),
      // Needs a query; the list route and the detail fill it in.
      fraudAccount: false,
    },
  };
}

function compare(a: AdminSellerListRow, b: AdminSellerListRow, sort: AdminSellerSort): number {
  switch (sort) {
    case 'OLDEST':
      return a.joinedAt.localeCompare(b.joinedAt);
    case 'GMV_HIGH':
      return b.gmvTotalPaise - a.gmvTotalPaise;
    case 'ORDERS_HIGH':
      return b.orderCount - a.orderCount;
    case 'NAME':
      return a.shopName.localeCompare(b.shopName);
    default:
      return b.joinedAt.localeCompare(a.joinedAt);
  }
}

/**
 * Live product counts and rating averages per seller. Ratings come from real
 * review rows, not the denormalised product cache — seeded catalogues carry
 * synthetic rating counts that would otherwise report millions of reviews.
 */
async function sellerAggregates(): Promise<{
  live: Map<string, number>;
  ratings: Map<string, { sum: number; count: number }>;
}> {
  const [liveGroups, reviews] = await Promise.all([
    prisma.product.groupBy({
      by: ['sellerId'],
      where: { status: 'APPROVED' },
      _count: { _all: true },
    }),
    prisma.review.findMany({
      select: { rating: true, product: { select: { sellerId: true } } },
    }),
  ]);

  const ratings = new Map<string, { sum: number; count: number }>();
  for (const review of reviews) {
    const sellerId = review.product.sellerId;
    const entry = ratings.get(sellerId) ?? { sum: 0, count: 0 };
    entry.sum += review.rating;
    entry.count += 1;
    ratings.set(sellerId, entry);
  }
  return {
    live: new Map(liveGroups.map((g) => [g.sellerId, g._count._all])),
    ratings,
  };
}

async function loadRows(query: z.infer<typeof listQuery>): Promise<AdminSellerListRow[]> {
  const where: Prisma.SellerProfileWhereInput = {
    ...(query.status !== 'ALL' ? { status: query.status } : {}),
    ...(query.kyc !== 'ALL' ? { kycStatus: query.kyc } : {}),
    ...(query.city ? { city: query.city } : {}),
    ...(query.q
      ? {
          OR: [
            { shopName: { contains: query.q, mode: 'insensitive' } },
            { user: { name: { contains: query.q, mode: 'insensitive' } } },
            { user: { phone: { contains: query.q } } },
            { user: { email: { contains: query.q, mode: 'insensitive' } } },
            { gstNumber: { contains: query.q, mode: 'insensitive' } },
            { id: { endsWith: query.q.toLowerCase().replace(/^sel-/i, '') } },
          ],
        }
      : {}),
  };

  const [sellers, sales, aggregates] = await Promise.all([
    prisma.sellerProfile.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: SCAN_CAP,
      include: SELLER_INCLUDE,
    }),
    salesBySeller(),
    sellerAggregates(),
  ]);

  return sellers
    .map((s) => {
      const rating = aggregates.ratings.get(s.id);
      return toRow(
        s,
        sales.get(s.id),
        aggregates.live.get(s.id) ?? 0,
        rating && rating.count > 0 ? Math.round((rating.sum / rating.count) * 10) / 10 : null,
      );
    })
    .sort((a, b) => compare(a, b, query.sort));
}

// ---------------------------------------------------------------------------
// GET / — the sellers table
// ---------------------------------------------------------------------------

adminSellersRouter.get('/', async (req, res, next) => {
  try {
    const query = listQuery.parse(req.query);
    const rows = await loadRows(query);
    const pageRows = rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
    const fraud = await sellersWithFraudFlag(pageRows.map((r) => r.id));
    for (const row of pageRows) row.kycAlerts.fraudAccount = fraud.has(row.id);
    const body: AdminSellerPage = {
      rows: pageRows,
      total: rows.length,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(rows.length / query.pageSize)),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /summary — KPIs, growth, verification split, top categories
// ---------------------------------------------------------------------------

function changePercent(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

adminSellersRouter.get('/summary', async (req, res, next) => {
  try {
    const rows = await loadRows(listQuery.parse({}));
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const joinedIn = (from: Date, to?: Date) =>
      rows.filter((r) => {
        const at = new Date(r.joinedAt);
        return at >= from && (!to || at < to);
      }).length;

    // Growth series over the last 30 days.
    const growth = new Map<string, number>();
    for (let i = GROWTH_DAYS - 1; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      growth.set(dayKey(d), 0);
    }
    for (const row of rows) {
      const key = dayKey(new Date(row.joinedAt));
      if (growth.has(key)) growth.set(key, (growth.get(key) ?? 0) + 1);
    }

    const statusCounts = new Map<AdminSellerStatus, number>();
    const kycCounts = new Map<KycStatus, number>();
    for (const row of rows) {
      statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
      kycCounts.set(row.kycStatus, (kycCounts.get(row.kycStatus) ?? 0) + 1);
    }

    // GMV by category across the whole marketplace.
    const sales = await salesBySeller();
    const categoryGmv = new Map<string, { name: string; gmvPaise: number }>();
    for (const roll of sales.values()) {
      for (const [id, cat] of roll.categoryGmv) {
        const entry = categoryGmv.get(id) ?? { name: cat.name, gmvPaise: 0 };
        entry.gmvPaise += cat.gmvPaise;
        categoryGmv.set(id, entry);
      }
    }
    const gmvTotal = [...categoryGmv.values()].reduce((sum, c) => sum + c.gmvPaise, 0);

    const cities = [...new Set(rows.map((r) => r.city).filter((c): c is string => !!c))].sort();

    const body: AdminSellerSummary = {
      kpis: {
        total: rows.length,
        totalChangePercent: changePercent(
          joinedIn(monthStart),
          joinedIn(prevMonthStart, monthStart),
        ),
        active: statusCounts.get('APPROVED') ?? 0,
        verified: kycCounts.get('VERIFIED') ?? 0,
        pendingVerification:
          (kycCounts.get('UNDER_REVIEW') ?? 0) + (kycCounts.get('PENDING_DOCS') ?? 0),
        suspended: statusCounts.get('SUSPENDED') ?? 0,
        banned: statusCounts.get('BANNED') ?? 0,
      },
      growth: [...growth.entries()].map(([date, count]) => ({ date, count })),
      verification: KYC_STATUSES.map((key) => ({
        key,
        label: KYC_STATUS_LABELS[key],
        count: kycCounts.get(key) ?? 0,
        share: rows.length > 0 ? Math.round(((kycCounts.get(key) ?? 0) / rows.length) * 1000) / 10 : 0,
      })).filter((v) => v.count > 0),
      statusDistribution: SELLER_STATUSES.map((key) => ({
        key,
        label: SELLER_STATUS_LABELS[key],
        count: statusCounts.get(key) ?? 0,
        share:
          rows.length > 0 ? Math.round(((statusCounts.get(key) ?? 0) / rows.length) * 1000) / 10 : 0,
      })).filter((s) => s.count > 0),
      topCategories: [...categoryGmv.entries()]
        .map(([id, c]) => ({
          id,
          name: c.name,
          gmvPaise: c.gmvPaise,
          share: gmvTotal > 0 ? Math.round((c.gmvPaise / gmvTotal) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.gmvPaise - a.gmvPaise)
        .slice(0, 5),
      cities,
      counts: {
        ALL: rows.length,
        ...(Object.fromEntries(
          SELLER_STATUSES.map((s) => [s, statusCounts.get(s) ?? 0]),
        ) as Record<AdminSellerStatus, number>),
      },
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Moderation: approve / reject / suspend / ban / reinstate
// ---------------------------------------------------------------------------

adminSellersRouter.patch('/:id/status', async (req, res, next) => {
  try {
    const input = adminSellerActionSchema.parse(req.body);
    const seller = await prisma.sellerProfile.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, phone: true } } },
    });
    if (!seller) throw ApiError.notFound('Seller not found');

    const now = new Date();
    const plan: Record<
      typeof input.action,
      { status: AdminSellerStatus; title: string; body: string }
    > = {
      approve: {
        status: 'APPROVED',
        title: 'Seller account approved 🎉',
        body: 'You can now list products on Clowe.',
      },
      reject: {
        status: 'REJECTED',
        title: 'Seller application rejected',
        body: 'reason' in input ? `Reason: ${input.reason}` : 'Contact support for details.',
      },
      suspend: {
        status: 'SUSPENDED',
        title: 'Seller account suspended',
        body: 'reason' in input ? `Reason: ${input.reason}` : 'Contact support for details.',
      },
      ban: {
        status: 'BANNED',
        title: 'Seller account banned',
        body: 'reason' in input ? `Reason: ${input.reason}` : 'Contact support for details.',
      },
      reinstate: {
        status: 'APPROVED',
        title: 'Seller account reinstated ✅',
        body: 'Your shop is live again. Thanks for working with us on this.',
      },
    };
    const step = plan[input.action];
    const reason = 'reason' in input ? input.reason : null;
    const blocking = step.status === 'SUSPENDED' || step.status === 'BANNED';

    // KYC never blocks approval — the admin decides — but with problems
    // outstanding, the request has to say it has seen them. Otherwise it is
    // refused with the list, so the confirmation always shows what is true
    // at the moment of approving rather than when the page was loaded.
    // It applies to a seller's first approval by any route — reinstating a
    // rejected application approves it too — but not to reinstating a seller
    // who was approved before and then suspended.
    let kycWarnings: string[] = [];
    const firstApproval = step.status === 'APPROVED' && seller.approvedAt === null;
    if (firstApproval) {
      kycWarnings = kycApprovalWarnings(await getSellerKycSummary(seller.id));
      const acknowledged = 'acknowledgeKycWarnings' in input && input.acknowledgeKycWarnings === true;
      if (kycWarnings.length > 0 && !acknowledged) {
        res.status(409).json({
          success: false,
          error: {
            code: 'KYC_WARNINGS_UNACKNOWLEDGED',
            message: `Approving with KYC problems outstanding:\n${kycWarnings.map((w) => `• ${w}`).join('\n')}`,
            warnings: kycWarnings,
          },
        });
        return;
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.sellerProfile.update({
        where: { id: seller.id },
        data: {
          status: step.status,
          rejectionReason: input.action === 'reject' ? reason : seller.rejectionReason,
          suspensionReason: blocking ? reason : null,
          suspendedAt: blocking ? now : null,
          approvedAt: step.status === 'APPROVED' ? (seller.approvedAt ?? now) : seller.approvedAt,
        },
      });
      // A blocked shop must disappear from the storefront immediately; a
      // reinstated one comes back exactly as it was.
      if (blocking) {
        await tx.product.updateMany({
          where: { sellerId: seller.id, status: 'APPROVED' },
          data: { isVisible: false },
        });
      } else if (input.action === 'reinstate') {
        await tx.product.updateMany({
          where: { sellerId: seller.id, status: 'APPROVED' },
          data: { isVisible: true },
        });
      }
      // Approving past KYC warnings leaves a record of exactly what was waved
      // through, on the seller's notes where the next admin will see it.
      if (kycWarnings.length > 0) {
        await tx.sellerNote.create({
          data: {
            sellerId: seller.id,
            authorId: req.auth!.userId,
            body: `Approved with KYC warnings acknowledged:\n${kycWarnings.map((w) => `• ${w}`).join('\n')}`,
          },
        });
      }
      await tx.notification.create({
        data: {
          userId: seller.user.id,
          type: `SELLER_${step.status}`,
          title: step.title,
          body: step.body,
        },
      });
    });

    if (blocking || input.action === 'reinstate') {
      sendToUserSafe(
        seller.user.id,
        {
          channel: 'whatsapp',
          to: `+91${seller.user.phone}`,
          body: `Clowe: ${step.title}. ${step.body}`,
        },
        { critical: true },
      );
    }

    res.json({ success: true, data: { id: seller.id, status: step.status } });
  } catch (err) {
    next(err);
  }
});

/** KYC review outcome + registered entity type. */
adminSellersRouter.patch('/:id/kyc', async (req, res, next) => {
  try {
    const input = adminSellerKycSchema.parse(req.body);
    const seller = await prisma.sellerProfile.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true } } },
    });
    if (!seller) throw ApiError.notFound('Seller not found');

    await prisma.sellerProfile.update({
      where: { id: seller.id },
      data: {
        kycStatus: input.kycStatus,
        kycReviewedAt: new Date(),
        ...(input.businessType !== undefined ? { businessType: input.businessType || null } : {}),
      },
    });

    if (input.kycStatus === 'VERIFIED' || input.kycStatus === 'REJECTED') {
      await prisma.notification.create({
        data: {
          userId: seller.user.id,
          type: `SELLER_KYC_${input.kycStatus}`,
          title: input.kycStatus === 'VERIFIED' ? 'KYC verified ✅' : 'KYC documents rejected',
          body:
            input.kycStatus === 'VERIFIED'
              ? 'Your business documents are verified — the verified badge now shows on your shop.'
              : 'We could not verify your documents. Please re-upload them from Store Settings.',
        },
      });
    }
    res.json({ success: true, data: { id: seller.id, kycStatus: input.kycStatus } });
  } catch (err) {
    next(err);
  }
});

/** Internal note — admin-only, never shown to the seller. */
/**
 * Re-run KYC checks for a seller: an admin retrying after an ERROR.
 * Still only calls the provider for checks with no answer: re-running a
 * verified PAN costs nothing because it does not happen.
 */
adminSellersRouter.post('/:id/kyc-checks', kycAdminRunLimiter, async (req, res, next) => {
  try {
    const { check } = z.object({ check: z.enum(KYC_CHECK_TYPES).optional() }).parse(req.body ?? {});
    const exists = await prisma.sellerProfile.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!exists) throw ApiError.notFound('Seller not found');
    const kyc = await runSellerKyc(exists.id, check ? [check] : undefined);
    res.json({ success: true, data: { kyc, kycApprovalWarnings: kycApprovalWarnings(kyc) } });
  } catch (err) {
    if (err instanceof KycCheckRunningError) {
      next(new ApiError(409, 'KYC_CHECK_RUNNING', 'Verification is already running for this seller.'));
      return;
    }
    next(err);
  }
});

adminSellersRouter.post('/:id/notes', async (req, res, next) => {
  try {
    const input = adminSellerNoteSchema.parse(req.body);
    const seller = await prisma.sellerProfile.findUnique({ where: { id: req.params.id } });
    if (!seller) throw ApiError.notFound('Seller not found');

    const note = await prisma.sellerNote.create({
      data: { sellerId: seller.id, authorId: req.auth!.userId, body: input.body },
      include: { author: { select: { name: true } } },
    });
    res.json({
      success: true,
      data: {
        id: note.id,
        body: note.body,
        authorName: note.author.name,
        createdAt: note.createdAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /export — the filtered list as CSV
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

adminSellersRouter.get('/export', async (req, res, next) => {
  try {
    const rows = await loadRows(listQuery.parse(req.query));
    const header = [
      'Seller ID',
      'Shop',
      'Owner',
      'Phone',
      'Email',
      'Business type',
      'Status',
      'KYC',
      'City',
      'State',
      'Joined',
      'Products',
      'Live products',
      'Orders',
      'GMV month (INR)',
      'GMV total (INR)',
      'Rating',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.sellerId,
          row.shopName,
          row.ownerName ?? '',
          row.phone,
          row.email ?? '',
          row.businessType ?? '',
          row.status,
          row.kycStatus,
          row.city ?? '',
          row.state ?? '',
          row.joinedAt,
          row.productCount,
          row.liveProductCount,
          row.orderCount,
          (row.gmvMonthPaise / 100).toFixed(2),
          (row.gmvTotalPaise / 100).toFixed(2),
          row.ratingAvg ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clowe-sellers.csv"');
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:id — the detail panel
// ---------------------------------------------------------------------------

adminSellersRouter.get('/:id', async (req, res, next) => {
  try {
    const seller = await prisma.sellerProfile.findUnique({
      where: { id: req.params.id },
      include: SELLER_INCLUDE,
    });
    if (!seller) throw ApiError.notFound('Seller not found');

    const [sales, aggregates, notes, orderItems, openReturns, payouts] = await Promise.all([
      salesBySeller(),
      sellerAggregates(),
      prisma.sellerNote.findMany({
        where: { sellerId: seller.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { author: { select: { name: true } } },
      }),
      prisma.orderItem.findMany({
        where: { sellerId: seller.id, order: { status: { not: 'PLACED' } } },
        orderBy: { order: { createdAt: 'desc' } },
        take: 60,
        select: {
          status: true,
          quantity: true,
          pricePaise: true,
          deliveredAt: true,
          shippedAt: true,
          order: { select: { orderNumber: true, createdAt: true, etaTo: true } },
        },
      }),
      prisma.return.count({
        where: { orderItem: { sellerId: seller.id }, status: { in: ['REQUESTED', 'APPROVED'] } },
      }),
      prisma.payout.aggregate({
        _sum: { netPaise: true },
        where: { sellerId: seller.id, status: 'PAID' },
      }),
    ]);

    const roll = sales.get(seller.id);
    const rating = aggregates.ratings.get(seller.id);
    const totalUnits =
      (roll?.unitsSold ?? 0) + (roll?.returnedUnits ?? 0) + (roll?.cancelledUnits ?? 0);

    // On-time = delivered on or before the ETA quoted at checkout.
    const withEta = orderItems.filter((i) => i.deliveredAt && i.order.etaTo);
    const onTime = withEta.filter((i) => i.deliveredAt! <= i.order.etaTo!).length;

    const reviewCount = rating?.count ?? 0;
    const kyc = await getSellerKycSummary(seller.id);
    const body: AdminSellerDetail = {
      ...toRow(
        seller,
        roll,
        aggregates.live.get(seller.id) ?? 0,
        rating && rating.count > 0 ? Math.round((rating.sum / rating.count) * 10) / 10 : null,
      ),
      description: seller.description,
      addressLine1: seller.addressLine1,
      pincode: seller.pincode,
      gstNumber: seller.gstNumber,
      panNumber: seller.panNumber,
      bankAccountName: seller.bankAccountName,
      // Never echo a full account number back to the browser.
      bankAccountNo: seller.bankAccountNo ? `••••${seller.bankAccountNo.slice(-4)}` : null,
      bankIfsc: seller.bankIfsc,
      kycReviewedAt: seller.kycReviewedAt?.toISOString() ?? null,
      approvedAt: seller.approvedAt?.toISOString() ?? null,
      panName: seller.panName,
      kyc,
      kycApprovalWarnings: kycApprovalWarnings(kyc),
      performance: {
        unitsSold: roll?.unitsSold ?? 0,
        returnRate:
          totalUnits > 0 ? Math.round(((roll?.returnedUnits ?? 0) / totalUnits) * 1000) / 10 : 0,
        cancelRate:
          totalUnits > 0 ? Math.round(((roll?.cancelledUnits ?? 0) / totalUnits) * 1000) / 10 : 0,
        onTimeRate: withEta.length > 0 ? Math.round((onTime / withEta.length) * 1000) / 10 : null,
        avgRating: rating && reviewCount > 0 ? Math.round((rating.sum / reviewCount) * 10) / 10 : null,
        reviewCount,
        openReturns,
        payoutsPaise: payouts._sum.netPaise ?? 0,
      },
      recentOrders: [
        ...new Map(
          orderItems.map((i) => [
            i.order.orderNumber,
            {
              orderNumber: i.order.orderNumber,
              placedAt: i.order.createdAt.toISOString(),
              amountPaise: i.pricePaise * i.quantity,
              status: i.status,
            },
          ]),
        ).values(),
      ].slice(0, 8),
      notes: notes.map((n) => ({
        id: n.id,
        body: n.body,
        authorName: n.author.name,
        createdAt: n.createdAt.toISOString(),
      })),
    };
    body.kycAlerts.fraudAccount = kyc.fraudAccount;
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
