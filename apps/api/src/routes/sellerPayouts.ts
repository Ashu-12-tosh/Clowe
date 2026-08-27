import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  PAYOUT_STATUSES,
  payoutMethodCreateSchema,
  payoutRequestSchema,
  type SellerPayoutDetail,
  type SellerPayoutLine,
  type SellerPayoutMethodRow,
  type SellerPayoutOverview,
  type SellerPayoutPage,
  type SellerPayoutRow,
  type PayoutStatusValue,
  type PayoutMethodTypeValue,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { getSettings } from '../services/settingsService';
import { payoutProvider } from '../services/payouts';
import {
  availableBalance,
  describeMethod,
  feesFor,
  requestPayout,
  sumFees,
} from '../services/payoutService';
import { requireSeller } from './seller';

export const sellerPayoutsRouter = Router();
sellerPayoutsRouter.use(requireAuth, requireSeller);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function monthRange(month?: string): { from: Date; to: Date; previousFrom: Date; previousTo: Date } {
  const now = new Date();
  const parsed = month && /^\d{4}-\d{2}$/.test(month) ? month.split('-').map(Number) : null;
  const year = parsed ? parsed[0] : now.getFullYear();
  const monthIndex = parsed ? parsed[1] - 1 : now.getMonth();
  const from = new Date(year, monthIndex, 1);
  const to = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
  return {
    from,
    to,
    previousFrom: new Date(year, monthIndex - 1, 1),
    previousTo: new Date(year, monthIndex, 0, 23, 59, 59, 999),
  };
}

/** Indian financial year containing `date`, e.g. "2026-27". */
function financialYear(date: Date): { label: string; from: Date; to: Date } {
  const year = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return {
    label: `${year}-${String((year + 1) % 100).padStart(2, '0')}`,
    from: new Date(year, 3, 1),
    to: new Date(year + 1, 2, 31, 23, 59, 59, 999),
  };
}

function changePercent(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type PayoutRecord = Prisma.PayoutGetPayload<{ include: { _count: { select: { items: true } } } }>;

function toPayoutRow(p: PayoutRecord): SellerPayoutRow {
  return {
    id: p.id,
    reference: p.reference,
    periodFrom: p.periodFrom.toISOString(),
    periodTo: p.periodTo.toISOString(),
    grossPaise: p.grossPaise,
    commissionPaise: p.commissionPaise,
    gatewayPaise: p.gatewayPaise,
    feesPaise: p.commissionPaise + p.gatewayPaise + p.otherFeesPaise,
    adjustmentPaise: p.adjustmentPaise,
    tdsPaise: p.tdsPaise,
    netPaise: p.netPaise,
    status: p.status as PayoutStatusValue,
    methodLabel: p.methodLabel,
    utr: p.utr,
    failureReason: p.failureReason,
    requestedAt: p.requestedAt.toISOString(),
    processedAt: p.processedAt?.toISOString() ?? null,
    itemCount: p._count.items,
  };
}

function toMethodRow(m: {
  id: string;
  type: string;
  label: string;
  accountName: string;
  accountLast4: string | null;
  ifsc: string | null;
  upiId: string | null;
  isDefault: boolean;
  verified: boolean;
  createdAt: Date;
}): SellerPayoutMethodRow {
  return {
    id: m.id,
    type: m.type as PayoutMethodTypeValue,
    label: m.label,
    accountName: m.accountName,
    accountLast4: m.accountLast4,
    ifsc: m.ifsc,
    upiId: m.upiId,
    isDefault: m.isDefault,
    verified: m.verified,
    createdAt: m.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET /overview
// ---------------------------------------------------------------------------

sellerPayoutsRouter.get('/overview', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const month = typeof req.query.month === 'string' ? req.query.month : undefined;
    const range = monthRange(month);
    const fy = financialYear(range.from);
    const settings = await getSettings();

    const delivered = (where: Prisma.OrderItemWhereInput) =>
      prisma.orderItem.findMany({
        where: { sellerId, status: { in: ['DELIVERED', 'RETURN_REQUESTED', 'RETURNED'] }, ...where },
        select: {
          pricePaise: true,
          quantity: true,
          deliveredAt: true,
          status: true,
          order: { select: { paymentMethod: true, shippingPaise: true } },
        },
      });

    const [monthItems, prevItems, fyItems, openingItems, balance, payouts, methods] =
      await Promise.all([
        delivered({ deliveredAt: { gte: range.from, lte: range.to } }),
        delivered({ deliveredAt: { gte: range.previousFrom, lte: range.previousTo } }),
        delivered({ deliveredAt: { gte: fy.from, lte: fy.to } }),
        delivered({ deliveredAt: { lt: range.from } }),
        availableBalance(sellerId),
        prisma.payout.findMany({
          where: { sellerId },
          orderBy: { requestedAt: 'desc' },
          include: { _count: { select: { items: true } } },
        }),
        prisma.sellerPayoutMethod.findMany({
          where: { sellerId },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        }),
      ]);

    // Returned lines were earned then reversed — they don't count as income.
    const earning = monthItems.filter((i) => i.status === 'DELIVERED');
    const prevEarning = prevItems.filter((i) => i.status === 'DELIVERED');
    const monthFees = sumFees(earning, settings);
    const prevFees = sumFees(prevEarning, settings);
    const fyFees = sumFees(
      fyItems.filter((i) => i.status === 'DELIVERED'),
      settings,
    );

    // Opening balance = everything cleared before this month, less what has
    // already been paid out or recovered before it.
    const openingEarned = sumFees(
      openingItems.filter((i) => i.status === 'DELIVERED'),
      settings,
    ).netPaise;
    const paidBefore = payouts
      .filter((p) => p.status !== 'FAILED' && p.requestedAt < range.from)
      .reduce((sum, p) => sum + p.netPaise + p.adjustmentPaise, 0);
    const openingBalancePaise = openingEarned - paidBefore;

    const paidInMonth = payouts
      .filter(
        (p) => p.status !== 'FAILED' && p.requestedAt >= range.from && p.requestedAt <= range.to,
      )
      .reduce((sum, p) => sum + p.netPaise, 0);

    // Daily series across the whole month.
    const days = new Map<string, { grossPaise: number; netPaise: number; feesPaise: number }>();
    for (let d = new Date(range.from); d <= range.to && d.getMonth() === range.from.getMonth(); d.setDate(d.getDate() + 1)) {
      days.set(dayKey(d), { grossPaise: 0, netPaise: 0, feesPaise: 0 });
    }
    for (const item of earning) {
      if (!item.deliveredAt) continue;
      const bucket = days.get(dayKey(item.deliveredAt));
      if (!bucket) continue;
      const line = feesFor(item.pricePaise * item.quantity, settings);
      bucket.grossPaise += line.grossPaise;
      bucket.netPaise += line.netPaise;
      bucket.feesPaise += line.feesPaise + line.tdsPaise;
    }

    // Where the month's gross came from. Shipping is what buyers paid for
    // delivery on these orders; the marketplace keeps it, so it is shown
    // separately rather than folded into the seller's product sales.
    const productSales = monthFees.grossPaise;
    const shipping = earning.reduce((sum, i) => sum + (i.order.shippingPaise ?? 0), 0);
    const codShare = earning
      .filter((i) => i.order.paymentMethod === 'COD')
      .reduce((sum, i) => sum + i.pricePaise * i.quantity, 0);
    const breakdownTotal = productSales + shipping;
    const breakdown = [
      { key: 'product', label: 'Product sales', amountPaise: productSales },
      { key: 'shipping', label: 'Shipping collected', amountPaise: shipping },
      { key: 'cod', label: '— of which Cash on Delivery', amountPaise: codShare },
    ].map((b) => ({
      ...b,
      share: breakdownTotal > 0 ? Math.round((b.amountPaise / breakdownTotal) * 1000) / 10 : 0,
    }));

    const finished = payouts.filter((p) => p.status === 'PAID' || p.status === 'FAILED');
    const successRate =
      finished.length > 0
        ? Math.round((finished.filter((p) => p.status === 'PAID').length / finished.length) * 1000) / 10
        : 100;

    const insights: SellerPayoutOverview['insights'] = [];
    if (monthFees.netPaise > 0 && prevFees.netPaise > 0) {
      const change = changePercent(monthFees.netPaise, prevFees.netPaise) ?? 0;
      insights.push({
        key: 'trend',
        tone: change >= 0 ? 'GOOD' : 'WARN',
        title: `Net earnings are ${change >= 0 ? 'up' : 'down'} ${Math.abs(change)}% this month`,
        body:
          change >= 0
            ? 'Keep the momentum — deliveries are what release money.'
            : 'Fewer deliveries cleared than last month.',
      });
    }
    if (balance.inClearingPaise > 0) {
      insights.push({
        key: 'clearing',
        tone: 'INFO',
        title: `₹${(balance.inClearingPaise / 100).toLocaleString('en-IN')} is clearing`,
        body: `Deliveries clear ${settings.payoutHoldDays} days after the buyer receives them (return window).`,
      });
    }
    if (balance.payablePaise >= settings.payoutMinPaise) {
      insights.push({
        key: 'payable',
        tone: 'GOOD',
        title: 'You can request a payout now',
        body: `₹${(balance.payablePaise / 100).toLocaleString('en-IN')} is cleared and ready to transfer.`,
      });
    } else if (balance.payablePaise > 0) {
      insights.push({
        key: 'below-min',
        tone: 'INFO',
        title: 'Below the minimum payout',
        body: `You need ₹${(settings.payoutMinPaise / 100).toLocaleString('en-IN')} cleared to request a transfer.`,
      });
    }
    if (methods.length === 0) {
      insights.push({
        key: 'no-method',
        tone: 'WARN',
        title: 'No payout method yet',
        body: 'Add and verify a bank account or UPI ID so money can reach you.',
      });
    }

    const body: SellerPayoutOverview = {
      rates: {
        commissionPercent: settings.payoutCommissionPercent,
        gatewayPercent: settings.payoutGatewayPercent,
        tdsPercent: settings.payoutTdsPercent,
        minPayoutPaise: settings.payoutMinPaise,
        holdDays: settings.payoutHoldDays,
      },
      kpis: {
        monthGrossPaise: monthFees.grossPaise,
        monthGrossChangePercent: changePercent(monthFees.grossPaise, prevFees.grossPaise),
        monthNetPaise: monthFees.netPaise,
        monthNetChangePercent: changePercent(monthFees.netPaise, prevFees.netPaise),
        payablePaise: balance.payablePaise,
        inClearingPaise: balance.inClearingPaise,
        nextClearingAt: balance.nextClearingAt,
        lifetimePaidPaise: payouts
          .filter((p) => p.status === 'PAID')
          .reduce((sum, p) => sum + p.netPaise, 0),
        payoutCount: payouts.filter((p) => p.status === 'PAID').length,
        successRate,
      },
      trend: [...days.entries()].map(([date, v]) => ({ date, ...v })),
      breakdown,
      summary: {
        openingBalancePaise,
        earningsPaise: monthFees.grossPaise,
        feesPaise: monthFees.feesPaise,
        tdsPaise: monthFees.tdsPaise,
        adjustmentsPaise: balance.adjustmentsPaise,
        paidOutPaise: paidInMonth,
        payablePaise: balance.payablePaise,
      },
      fees: {
        commissionPaise: monthFees.commissionPaise,
        gatewayPaise: monthFees.gatewayPaise,
        adjustmentsPaise: balance.adjustmentsPaise,
        totalPaise: monthFees.feesPaise + balance.adjustmentsPaise,
      },
      tds: {
        financialYear: fy.label,
        grossSalesPaise: fyFees.grossPaise,
        tdsWithheldPaise: fyFees.tdsPaise,
        // Withheld TDS is deposited with the payout that carried it.
        tdsDepositedPaise: payouts
          .filter((p) => p.status === 'PAID' && p.requestedAt >= fy.from && p.requestedAt <= fy.to)
          .reduce((sum, p) => sum + p.tdsPaise, 0),
      },
      recentPayouts: payouts.slice(0, 5).map(toPayoutRow),
      methods: methods.map(toMethodRow),
      insights,
    };

    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Payout history
// ---------------------------------------------------------------------------

const historyQuery = z.object({
  status: z.enum(['ALL', ...PAYOUT_STATUSES]).default('ALL'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(10),
});

sellerPayoutsRouter.get('/', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const query = historyQuery.parse(req.query);
    const where: Prisma.PayoutWhereInput = {
      sellerId,
      ...(query.status !== 'ALL' ? { status: query.status } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.payout.count({ where }),
      prisma.payout.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { _count: { select: { items: true } } },
      }),
    ]);

    const body: SellerPayoutPage = {
      rows: rows.map(toPayoutRow),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Payout methods
// ---------------------------------------------------------------------------

sellerPayoutsRouter.get('/methods', async (req, res, next) => {
  try {
    const methods = await prisma.sellerPayoutMethod.findMany({
      where: { sellerId: req.seller!.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    res.json({ success: true, data: methods.map(toMethodRow) });
  } catch (err) {
    next(err);
  }
});

sellerPayoutsRouter.post('/methods', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const input = payoutMethodCreateSchema.parse(req.body);

    // Only the last 4 digits are kept — the full number never lands in our DB.
    const accountLast4 = input.accountNumber ? input.accountNumber.slice(-4) : null;
    const check = await payoutProvider.verifyMethod({
      accountLast4,
      ifsc: input.ifsc ?? null,
      upiId: input.upiId ?? null,
    });

    const created = await prisma.$transaction(async (tx) => {
      const isFirst = (await tx.sellerPayoutMethod.count({ where: { sellerId } })) === 0;
      const makeDefault = input.makeDefault || isFirst;
      if (makeDefault) {
        await tx.sellerPayoutMethod.updateMany({ where: { sellerId }, data: { isDefault: false } });
      }
      return tx.sellerPayoutMethod.create({
        data: {
          sellerId,
          type: input.type,
          label: input.label,
          accountName: input.accountName,
          accountLast4,
          ifsc: input.ifsc ?? null,
          upiId: input.upiId ?? null,
          isDefault: makeDefault,
          verified: check.verified,
          verifiedAt: check.verified ? new Date() : null,
        },
      });
    });

    res.json({ success: true, data: toMethodRow(created) });
  } catch (err) {
    next(err);
  }
});

sellerPayoutsRouter.patch('/methods/:id/default', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const method = await prisma.sellerPayoutMethod.findFirst({
      where: { id: req.params.id, sellerId },
    });
    if (!method) throw ApiError.notFound('Payout method not found');

    await prisma.$transaction([
      prisma.sellerPayoutMethod.updateMany({ where: { sellerId }, data: { isDefault: false } }),
      prisma.sellerPayoutMethod.update({ where: { id: method.id }, data: { isDefault: true } }),
    ]);
    res.json({ success: true, data: { id: method.id } });
  } catch (err) {
    next(err);
  }
});

sellerPayoutsRouter.delete('/methods/:id', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const method = await prisma.sellerPayoutMethod.findFirst({
      where: { id: req.params.id, sellerId },
    });
    if (!method) throw ApiError.notFound('Payout method not found');

    const inFlight = await prisma.payout.count({
      where: { methodId: method.id, status: { in: ['PENDING', 'PROCESSING'] } },
    });
    if (inFlight > 0) {
      throw ApiError.badRequest('A payout is in progress on this method', 'METHOD_IN_USE');
    }

    await prisma.sellerPayoutMethod.delete({ where: { id: method.id } });
    // Keep exactly one default around.
    const remaining = await prisma.sellerPayoutMethod.findFirst({
      where: { sellerId },
      orderBy: { createdAt: 'asc' },
    });
    if (remaining && !remaining.isDefault) {
      await prisma.sellerPayoutMethod.update({
        where: { id: remaining.id },
        data: { isDefault: true },
      });
    }
    res.json({ success: true, data: { id: method.id } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Request a payout
// ---------------------------------------------------------------------------

sellerPayoutsRouter.post('/request', async (req, res, next) => {
  try {
    const input = payoutRequestSchema.parse(req.body ?? {});
    const payout = await requestPayout(req.seller!.id, input.methodId);
    const withCount = await prisma.payout.findUniqueOrThrow({
      where: { id: payout.id },
      include: { _count: { select: { items: true } } },
    });
    res.json({ success: true, data: toPayoutRow(withCount) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Statement & TDS exports
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

sellerPayoutsRouter.get('/statement', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const range = monthRange(typeof req.query.month === 'string' ? req.query.month : undefined);
    const settings = await getSettings();

    const items = await prisma.orderItem.findMany({
      where: {
        sellerId,
        status: 'DELIVERED',
        deliveredAt: { gte: range.from, lte: range.to },
      },
      orderBy: { deliveredAt: 'asc' },
      select: {
        title: true,
        quantity: true,
        pricePaise: true,
        deliveredAt: true,
        payout: { select: { reference: true, status: true } },
        order: { select: { orderNumber: true, paymentMethod: true } },
      },
    });

    const header = [
      'Delivered on',
      'Order number',
      'Item',
      'Qty',
      'Gross (INR)',
      'Commission (INR)',
      'Gateway (INR)',
      'TDS (INR)',
      'Net (INR)',
      'Payment method',
      'Payout',
      'Payout status',
    ];
    const lines = [header.join(',')];
    for (const item of items) {
      const fee = feesFor(item.pricePaise * item.quantity, settings);
      lines.push(
        [
          item.deliveredAt?.toISOString() ?? '',
          item.order.orderNumber,
          item.title,
          item.quantity,
          (fee.grossPaise / 100).toFixed(2),
          (fee.commissionPaise / 100).toFixed(2),
          (fee.gatewayPaise / 100).toFixed(2),
          (fee.tdsPaise / 100).toFixed(2),
          (fee.netPaise / 100).toFixed(2),
          item.order.paymentMethod,
          item.payout?.reference ?? 'Unsettled',
          item.payout?.status ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="clowe-statement-${dayKey(range.from).slice(0, 7)}.csv"`,
    );
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

sellerPayoutsRouter.get('/tds-report', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const fy = financialYear(new Date());
    const payouts = await prisma.payout.findMany({
      where: { sellerId, requestedAt: { gte: fy.from, lte: fy.to } },
      orderBy: { requestedAt: 'asc' },
    });

    const header = [
      'Payout',
      'Requested on',
      'Period from',
      'Period to',
      'Gross (INR)',
      'TDS 194-O (INR)',
      'Net paid (INR)',
      'Status',
      'UTR',
    ];
    const lines = [header.join(',')];
    for (const p of payouts) {
      lines.push(
        [
          p.reference,
          p.requestedAt.toISOString(),
          p.periodFrom.toISOString().slice(0, 10),
          p.periodTo.toISOString().slice(0, 10),
          (p.grossPaise / 100).toFixed(2),
          (p.tdsPaise / 100).toFixed(2),
          (p.netPaise / 100).toFixed(2),
          p.status,
          p.utr ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="clowe-tds-${fy.label}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// One payout, with the lines it settled
// ---------------------------------------------------------------------------

sellerPayoutsRouter.get('/:id', async (req, res, next) => {
  try {
    const sellerId = req.seller!.id;
    const settings = await getSettings();
    const payout = await prisma.payout.findFirst({
      where: { id: req.params.id, sellerId },
      include: {
        _count: { select: { items: true } },
        items: {
          select: {
            id: true,
            title: true,
            quantity: true,
            pricePaise: true,
            deliveredAt: true,
            order: { select: { orderNumber: true } },
          },
        },
        ads: { select: { id: true, placement: true, pricePaise: true, createdAt: true } },
      },
    });
    if (!payout) throw ApiError.notFound('Payout not found');

    const lines: SellerPayoutLine[] = payout.items.map((item) => {
      const fee = feesFor(item.pricePaise * item.quantity, settings);
      return {
        orderItemId: item.id,
        orderNumber: item.order.orderNumber,
        title: item.title,
        quantity: item.quantity,
        deliveredAt: item.deliveredAt?.toISOString() ?? null,
        grossPaise: fee.grossPaise,
        commissionPaise: fee.commissionPaise,
        gatewayPaise: fee.gatewayPaise,
        tdsPaise: fee.tdsPaise,
        netPaise: fee.netPaise,
      };
    });

    const body: SellerPayoutDetail = {
      ...toPayoutRow(payout),
      lines,
      adjustments: payout.ads.map((ad) => ({
        id: ad.id,
        placement: ad.placement,
        pricePaise: ad.pricePaise,
        createdAt: ad.createdAt.toISOString(),
      })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

export { describeMethod };
