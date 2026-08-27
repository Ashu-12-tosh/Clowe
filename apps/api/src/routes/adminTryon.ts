import fs from 'node:fs/promises';
import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  TRYON_DEVICE_LABELS,
  adminTryOnFlagSchema,
  adminTryOnSettingsSchema,
  type AdminTryOnHealth,
  type AdminTryOnHealthCheck,
  type AdminTryOnMetric,
  type AdminTryOnOverview,
  type AdminTryOnRequestDetail,
  type AdminTryOnRequestPage,
  type AdminTryOnRequestRow,
  type AdminTryOnSettings,
  type AdminTryOnShare,
  type TryOnDeviceType,
  type TryOnFeedback,
  type TryOnStatusValue,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { getSettings, setSetting } from '../services/settingsService';
import { tryOnProvider } from '../services/tryon';
import { uploadDir } from './uploads';

export const adminTryonRouter = Router();
adminTryonRouter.use(requireAuth, requireRole('ADMIN'));

/** Hard cap on rows pulled into memory for the aggregate panels. */
const AGGREGATE_ROW_CAP = 20000;
/** A run still PENDING after this long is treated as stuck. */
const STUCK_PENDING_MS = 2 * 60 * 1000;
/** Successful runs slower than this count against the "fast" quality bar. */
const FAST_RUN_MS = 10000;

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

interface Range {
  from: Date;
  to: Date;
  days: number;
  previousFrom: Date;
  previousTo: Date;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function dayKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Range from ?from/?to (ISO dates), defaulting to the last 30 days. */
function parseRange(query: Record<string, unknown>): Range {
  const rawFrom = typeof query.from === 'string' ? new Date(query.from) : null;
  const rawTo = typeof query.to === 'string' ? new Date(query.to) : null;
  const to = endOfDay(rawTo && !Number.isNaN(rawTo.getTime()) ? rawTo : new Date());
  const defaultFrom = new Date(to);
  defaultFrom.setDate(defaultFrom.getDate() - 29);
  const from = startOfDay(rawFrom && !Number.isNaN(rawFrom.getTime()) ? rawFrom : defaultFrom);
  const days = Math.max(1, Math.round((endOfDay(to).getTime() - from.getTime()) / 86400000));
  const previousTo = new Date(from.getTime() - 1);
  const previousFrom = new Date(from);
  previousFrom.setDate(previousFrom.getDate() - days);
  return { from, to, days, previousFrom: startOfDay(previousFrom), previousTo };
}

/** Category filter matches the category itself and its subcategories. */
async function categoryIdsFor(categoryId: string): Promise<string[]> {
  const children = await prisma.category.findMany({
    where: { parentId: categoryId },
    select: { id: true },
  });
  return [categoryId, ...children.map((c) => c.id)];
}

async function buildWhere(
  query: Record<string, unknown>,
  range: { from: Date; to: Date },
): Promise<Prisma.TryOnHistoryWhereInput> {
  const where: Prisma.TryOnHistoryWhereInput = {
    createdAt: { gte: range.from, lte: range.to },
  };

  const provider = typeof query.provider === 'string' ? query.provider.trim() : '';
  if (provider) where.provider = provider;

  const status = typeof query.status === 'string' ? query.status.trim() : '';
  if (status === 'PENDING' || status === 'SUCCESS' || status === 'FAILED') where.status = status;

  // OR-groups are collected here so several of them can coexist.
  const and: Prisma.TryOnHistoryWhereInput[] = [];

  // Runs recorded before device capture existed count as "Other".
  const device = typeof query.device === 'string' ? query.device.trim() : '';
  if (device === 'OTHER') and.push({ OR: [{ deviceType: 'OTHER' }, { deviceType: null }] });
  else if (device) where.deviceType = device;

  const gender = typeof query.gender === 'string' ? query.gender.trim() : '';
  if (gender) {
    where.user =
      gender === 'UNSPECIFIED'
        ? { OR: [{ gender: null }, { gender: 'PREFER_NOT_TO_SAY' }] }
        : { gender };
  }

  const categoryId = typeof query.categoryId === 'string' ? query.categoryId.trim() : '';
  if (categoryId) {
    where.product = { categoryId: { in: await categoryIdsFor(categoryId) } };
  }

  const q = typeof query.q === 'string' ? query.q.trim() : '';
  if (q) {
    // Search matches the request reference, the shopper or the product.
    const idFragment = q.replace(/^TR-\d{8}-/i, '').toLowerCase();
    and.push({
      OR: [
        { id: { endsWith: idFragment } },
        { user: { name: { contains: q, mode: 'insensitive' } } },
        { user: { phone: { contains: q } } },
        { product: { title: { contains: q, mode: 'insensitive' } } },
      ],
    });
  }

  if (and.length > 0) where.AND = and;
  return where;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function metric(value: number, previous: number): AdminTryOnMetric {
  const changePercent =
    previous > 0 ? Math.round(((value - previous) / previous) * 1000) / 10 : null;
  return { value, previous, changePercent };
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function shares(
  counts: Map<string, number>,
  total: number,
  label: (key: string) => string,
): AdminTryOnShare[] {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: label(key), count, share: pct(count, total) }))
    .sort((a, b) => b.count - a.count);
}

function requestRef(id: string, createdAt: Date): string {
  const y = createdAt.getFullYear();
  const m = `${createdAt.getMonth() + 1}`.padStart(2, '0');
  const d = `${createdAt.getDate()}`.padStart(2, '0');
  return `TR-${y}${m}${d}-${id.slice(-4).toUpperCase()}`;
}

const GENDER_LABELS: Record<string, string> = {
  MALE: 'Men',
  FEMALE: 'Women',
  OTHER: 'Other',
  UNSPECIFIED: 'Not specified',
};

function genderKey(gender: string | null): string {
  if (!gender || gender === 'PREFER_NOT_TO_SAY') return 'UNSPECIFIED';
  return gender;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

// ---------------------------------------------------------------------------
// GET /api/admin/tryon/overview — every KPI, chart and panel on the monitor
// ---------------------------------------------------------------------------

adminTryonRouter.get('/overview', async (req, res, next) => {
  try {
    const range = parseRange(req.query as Record<string, unknown>);
    const where = await buildWhere(req.query as Record<string, unknown>, range);
    const prevWhere = await buildWhere(req.query as Record<string, unknown>, {
      from: range.previousFrom,
      to: range.previousTo,
    });

    const [rows, prevRows, settings] = await Promise.all([
      prisma.tryOnHistory.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: AGGREGATE_ROW_CAP,
        select: {
          id: true,
          userId: true,
          productId: true,
          status: true,
          provider: true,
          deviceType: true,
          durationMs: true,
          costPaise: true,
          feedback: true,
          flagged: true,
          createdAt: true,
          user: { select: { gender: true, name: true, phone: true } },
          product: {
            select: {
              title: true,
              slug: true,
              category: { select: { id: true, name: true, parentId: true } },
            },
          },
        },
      }),
      prisma.tryOnHistory.findMany({
        where: prevWhere,
        take: AGGREGATE_ROW_CAP,
        select: {
          userId: true,
          status: true,
          durationMs: true,
          costPaise: true,
        },
      }),
      getSettings(),
    ]);

    const total = rows.length;
    const success = rows.filter((r) => r.status === 'SUCCESS');
    const failed = rows.filter((r) => r.status === 'FAILED');
    const durations = success.map((r) => r.durationMs).filter((d): d is number => d != null);

    const prevSuccess = prevRows.filter((r) => r.status === 'SUCCESS');
    const prevDurations = prevSuccess
      .map((r) => r.durationMs)
      .filter((d): d is number => d != null);

    // --- Daily series -------------------------------------------------------
    const trendMap = new Map<string, { total: number; success: number; failed: number }>();
    const latencyMap = new Map<string, number[]>();
    for (let i = 0; i < range.days; i += 1) {
      const d = new Date(range.from);
      d.setDate(d.getDate() + i);
      trendMap.set(dayKey(d), { total: 0, success: 0, failed: 0 });
      latencyMap.set(dayKey(d), []);
    }
    for (const r of rows) {
      const key = dayKey(r.createdAt);
      const bucket = trendMap.get(key);
      if (!bucket) continue;
      bucket.total += 1;
      if (r.status === 'SUCCESS') bucket.success += 1;
      if (r.status === 'FAILED') bucket.failed += 1;
      if (r.status === 'SUCCESS' && r.durationMs != null) latencyMap.get(key)!.push(r.durationMs);
    }

    // --- Distributions ------------------------------------------------------
    const categoryCounts = new Map<string, number>();
    const categoryNames = new Map<string, string>();
    const genderCounts = new Map<string, number>();
    const deviceCounts = new Map<string, number>();
    const providerRuns = new Map<string, typeof rows>();
    const userCounts = new Map<string, { total: number; success: number; failed: number }>();
    const productCounts = new Map<string, { total: number; up: number; down: number }>();

    for (const r of rows) {
      const cat = r.product.category;
      categoryCounts.set(cat.id, (categoryCounts.get(cat.id) ?? 0) + 1);
      categoryNames.set(cat.id, cat.name);

      const g = genderKey(r.user.gender);
      genderCounts.set(g, (genderCounts.get(g) ?? 0) + 1);

      const dev = (r.deviceType ?? 'OTHER') as TryOnDeviceType;
      deviceCounts.set(dev, (deviceCounts.get(dev) ?? 0) + 1);

      const list = providerRuns.get(r.provider) ?? [];
      list.push(r);
      providerRuns.set(r.provider, list);

      const u = userCounts.get(r.userId) ?? { total: 0, success: 0, failed: 0 };
      u.total += 1;
      if (r.status === 'SUCCESS') u.success += 1;
      if (r.status === 'FAILED') u.failed += 1;
      userCounts.set(r.userId, u);

      const p = productCounts.get(r.productId) ?? { total: 0, up: 0, down: 0 };
      p.total += 1;
      if (r.feedback === 'UP') p.up += 1;
      if (r.feedback === 'DOWN') p.down += 1;
      productCounts.set(r.productId, p);
    }

    const userMeta = new Map(rows.map((r) => [r.userId, r.user]));
    const productMeta = new Map(rows.map((r) => [r.productId, r.product]));

    // --- Quality ------------------------------------------------------------
    const up = rows.filter((r) => r.feedback === 'UP').length;
    const down = rows.filter((r) => r.feedback === 'DOWN').length;
    const ratedCount = up + down;
    const fastRuns = durations.filter((d) => d <= FAST_RUN_MS).length;
    const repeatUsers = [...userCounts.values()].filter((u) => u.total > 1).length;

    const bars = [
      {
        key: 'fit',
        label: 'Fit approval',
        value: pct(up, ratedCount),
        detail: ratedCount > 0 ? `${up} of ${ratedCount} rated runs 👍` : 'No ratings yet',
        weighted: ratedCount > 0,
      },
      {
        key: 'success',
        label: 'Generation success',
        value: pct(success.length, total),
        detail: `${success.length} of ${total} runs completed`,
        weighted: total > 0,
      },
      {
        key: 'speed',
        label: `Under ${FAST_RUN_MS / 1000}s`,
        value: pct(fastRuns, durations.length),
        detail:
          durations.length > 0
            ? `${fastRuns} of ${durations.length} timed runs`
            : 'No timing data yet',
        weighted: durations.length > 0,
      },
      {
        key: 'repeat',
        label: 'Repeat usage',
        value: pct(repeatUsers, userCounts.size),
        detail:
          userCounts.size > 0
            ? `${repeatUsers} of ${userCounts.size} shoppers came back`
            : 'No shoppers yet',
        weighted: userCounts.size > 0,
      },
    ];
    const scored = bars.filter((b) => b.weighted);
    const score =
      scored.length > 0
        ? Math.round((scored.reduce((s, b) => s + b.value, 0) / scored.length / 20) * 100) / 100
        : 0;

    // --- Abuse & safety -----------------------------------------------------
    // "Blocked by quota" = shopper-days that reached the configured daily cap.
    const perUserDay = new Map<string, number>();
    for (const r of rows) {
      if (r.status === 'FAILED') continue;
      const key = `${r.userId}|${dayKey(r.createdAt)}`;
      perUserDay.set(key, (perUserDay.get(key) ?? 0) + 1);
    }
    const blockedByQuota = [...perUserDay.values()].filter(
      (n) => n >= settings.tryonDailyLimit,
    ).length;

    const body: AdminTryOnOverview = {
      range: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        days: range.days,
        previousFrom: range.previousFrom.toISOString(),
        previousTo: range.previousTo.toISOString(),
      },
      kpis: {
        total: metric(total, prevRows.length),
        uniqueUsers: metric(userCounts.size, new Set(prevRows.map((r) => r.userId)).size),
        success: metric(success.length, prevSuccess.length),
        failed: metric(failed.length, prevRows.filter((r) => r.status === 'FAILED').length),
        costPaise: metric(
          rows.reduce((s, r) => s + r.costPaise, 0),
          prevRows.reduce((s, r) => s + r.costPaise, 0),
        ),
        avgDurationMs: metric(avg(durations), avg(prevDurations)),
        successRate: pct(success.length, total),
        failureRate: pct(failed.length, total),
      },
      trend: [...trendMap.entries()].map(([date, v]) => ({ date, ...v })),
      latency: [...latencyMap.entries()].map(([date, values]) => ({ date, avgMs: avg(values) })),
      categories: shares(categoryCounts, total, (id) => categoryNames.get(id) ?? 'Unknown').slice(
        0,
        8,
      ),
      gender: shares(genderCounts, total, (k) => GENDER_LABELS[k] ?? k),
      devices: shares(deviceCounts, total, (k) => TRYON_DEVICE_LABELS[k as TryOnDeviceType] ?? k),
      providers: [...providerRuns.entries()]
        .map(([provider, list]) => {
          const ok = list.filter((r) => r.status === 'SUCCESS');
          return {
            provider,
            total: list.length,
            success: ok.length,
            successRate: pct(ok.length, list.length),
            avgDurationMs: avg(ok.map((r) => r.durationMs).filter((d): d is number => d != null)),
            costPaise: list.reduce((s, r) => s + r.costPaise, 0),
          };
        })
        .sort((a, b) => b.total - a.total),
      quality: {
        score,
        ratedCount,
        up,
        down,
        bars: bars.map(({ key, label, value, detail }) => ({ key, label, value, detail })),
      },
      topUsers: [...userCounts.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 8)
        .map(([userId, stats]) => ({
          userId,
          name: userMeta.get(userId)?.name ?? null,
          phone: userMeta.get(userId)?.phone ?? '',
          total: stats.total,
          success: stats.success,
          failed: stats.failed,
          successRate: pct(stats.success, stats.total),
        })),
      topProducts: [...productCounts.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 8)
        .map(([productId, stats]) => ({
          productId,
          title: productMeta.get(productId)?.title ?? 'Unknown',
          slug: productMeta.get(productId)?.slug ?? '',
          total: stats.total,
          upVotes: stats.up,
          downVotes: stats.down,
        })),
      abuse: {
        flagged: rows.filter((r) => r.flagged).length,
        failed: failed.length,
        ratedDown: down,
        blockedByQuota,
      },
      health: await systemHealth(),
    };

    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// System health — real probes, not decoration
// ---------------------------------------------------------------------------

async function systemHealth(): Promise<AdminTryOnHealth> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const checks: AdminTryOnHealthCheck[] = [];

  const [recent, stuck, settings] = await Promise.all([
    prisma.tryOnHistory.findMany({
      where: { createdAt: { gte: since } },
      select: { status: true, durationMs: true },
    }),
    prisma.tryOnHistory.count({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - STUCK_PENDING_MS) } },
    }),
    getSettings(),
  ]);

  const recentFailed = recent.filter((r) => r.status === 'FAILED').length;
  const failureRate = pct(recentFailed, recent.length);

  checks.push({
    key: 'generation',
    label: 'AI Generation Service',
    status: !settings.tryonEnabled
      ? 'DOWN'
      : recent.length >= 5 && failureRate > 50
        ? 'DOWN'
        : recent.length >= 5 && failureRate > 20
          ? 'DEGRADED'
          : 'OPERATIONAL',
    detail: !settings.tryonEnabled
      ? 'Paused by admin (kill switch off)'
      : `${tryOnProvider.name} provider · ${failureRate}% failures in 24h`,
  });

  const recentDurations = recent
    .filter((r) => r.status === 'SUCCESS')
    .map((r) => r.durationMs)
    .filter((d): d is number => d != null);
  const avgMs = avg(recentDurations);
  checks.push({
    key: 'inference',
    label: 'Model Inference',
    status: avgMs === 0 ? 'OPERATIONAL' : avgMs > 20000 ? 'DEGRADED' : 'OPERATIONAL',
    detail:
      recentDurations.length > 0
        ? `Avg ${(avgMs / 1000).toFixed(2)}s over ${recentDurations.length} runs (24h)`
        : 'No runs in the last 24h',
  });

  checks.push({
    key: 'queue',
    label: 'Queue System',
    status: stuck === 0 ? 'OPERATIONAL' : stuck > 10 ? 'DOWN' : 'DEGRADED',
    detail: stuck === 0 ? 'No stuck runs' : `${stuck} run(s) pending over 2 min`,
  });

  let storage: AdminTryOnHealthCheck = {
    key: 'storage',
    label: 'Image Storage',
    status: 'OPERATIONAL',
    detail: 'Upload directory writable',
  };
  try {
    await fs.access(uploadDir, fs.constants.W_OK);
  } catch {
    storage = {
      key: 'storage',
      label: 'Image Storage',
      status: 'DOWN',
      detail: 'Upload directory is not writable',
    };
  }
  checks.push(storage);

  let database: AdminTryOnHealthCheck = {
    key: 'database',
    label: 'History Database',
    status: 'OPERATIONAL',
    detail: 'Responding',
  };
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = {
      key: 'database',
      label: 'History Database',
      status: 'DOWN',
      detail: 'Query failed',
    };
  }
  checks.push(database);

  const overall = checks.some((c) => c.status === 'DOWN')
    ? 'DOWN'
    : checks.some((c) => c.status === 'DEGRADED')
      ? 'DEGRADED'
      : 'OPERATIONAL';

  return { overall, checks };
}

adminTryonRouter.get('/health', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await systemHealth() });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Requests table
// ---------------------------------------------------------------------------

const REQUEST_INCLUDE = {
  user: { select: { id: true, name: true, phone: true, gender: true } },
  product: {
    select: {
      id: true,
      title: true,
      slug: true,
      category: { select: { name: true } },
    },
  },
} as const;

type RequestRecord = Prisma.TryOnHistoryGetPayload<{ include: typeof REQUEST_INCLUDE }>;

function toRow(r: RequestRecord): AdminTryOnRequestRow {
  return {
    id: r.id,
    requestId: requestRef(r.id, r.createdAt),
    userId: r.userId,
    userName: r.user.name,
    userPhone: r.user.phone,
    userGender: r.user.gender,
    productId: r.productId,
    productTitle: r.product.title,
    productSlug: r.product.slug,
    categoryName: r.product.category.name,
    inputImageUrl: r.inputImageUrl,
    resultImageUrl: r.resultImageUrl,
    status: r.status as TryOnStatusValue,
    provider: r.provider,
    durationMs: r.durationMs,
    costPaise: r.costPaise,
    deviceType: (r.deviceType as TryOnDeviceType | null) ?? null,
    feedback: (r.feedback as TryOnFeedback | null) ?? null,
    flagged: r.flagged,
    flagReason: r.flagReason,
    errorMessage: r.errorMessage,
    variantSize: r.variantSize,
    variantColor: r.variantColor,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Tab narrows the filtered set: failures, flagged content, poor-fit reports. */
function applyTab(
  where: Prisma.TryOnHistoryWhereInput,
  tab: string,
): Prisma.TryOnHistoryWhereInput {
  switch (tab) {
    case 'FAILED':
      return { ...where, status: 'FAILED' };
    case 'FLAGGED':
      return { ...where, flagged: true };
    case 'RATED_DOWN':
      return { ...where, feedback: 'DOWN' };
    default:
      return where;
  }
}

adminTryonRouter.get('/requests', async (req, res, next) => {
  try {
    const query = req.query as Record<string, unknown>;
    const range = parseRange(query);
    const base = await buildWhere(query, range);
    const where = applyTab(base, typeof query.tab === 'string' ? query.tab : 'RECENT');

    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(query.pageSize) || 10));

    const [total, records] = await Promise.all([
      prisma.tryOnHistory.count({ where }),
      prisma.tryOnHistory.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: REQUEST_INCLUDE,
      }),
    ]);

    const body: AdminTryOnRequestPage = {
      rows: records.map(toRow),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

adminTryonRouter.get('/requests/:id', async (req, res, next) => {
  try {
    const record = await prisma.tryOnHistory.findUnique({
      where: { id: req.params.id },
      include: {
        user: {
          select: { id: true, name: true, phone: true, gender: true, email: true, createdAt: true },
        },
        product: {
          select: {
            id: true,
            title: true,
            slug: true,
            brand: true,
            basePricePaise: true,
            category: { select: { name: true } },
            seller: { select: { shopName: true } },
          },
        },
      },
    });
    if (!record) throw ApiError.notFound('Try-on not found');

    const userTotalTryOns = await prisma.tryOnHistory.count({ where: { userId: record.userId } });

    const body: AdminTryOnRequestDetail = {
      ...toRow(record as unknown as RequestRecord),
      userEmail: record.user.email,
      userJoinedAt: record.user.createdAt.toISOString(),
      userTotalTryOns,
      productPricePaise: record.product.basePricePaise,
      productBrand: record.product.brand,
      sellerShopName: record.product.seller?.shopName ?? null,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

/** Flag / unflag a run for abuse review. */
adminTryonRouter.post('/requests/:id/flag', async (req, res, next) => {
  try {
    const input = adminTryOnFlagSchema.parse(req.body);
    const exists = await prisma.tryOnHistory.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!exists) throw ApiError.notFound('Try-on not found');

    const record = await prisma.tryOnHistory.update({
      where: { id: req.params.id },
      data: input.flagged
        ? {
            flagged: true,
            flagReason: input.reason?.trim() || 'Flagged by admin',
            flaggedAt: new Date(),
          }
        : { flagged: false, flagReason: null, flaggedAt: null },
      include: REQUEST_INCLUDE,
    });
    res.json({ success: true, data: toRow(record) });
  } catch (err) {
    next(err);
  }
});

/** Delete a run's stored result (takedown for abusive/unsafe output). */
adminTryonRouter.delete('/requests/:id/result', async (req, res, next) => {
  try {
    const record = await prisma.tryOnHistory.findUnique({
      where: { id: req.params.id },
      select: { id: true, resultImageUrl: true },
    });
    if (!record) throw ApiError.notFound('Try-on not found');

    // Remove the generated file when it is one of ours, then clear the link.
    const filename = record.resultImageUrl?.split('/uploads/')[1];
    if (filename && !filename.includes('/')) {
      await fs.unlink(`${uploadDir}/${filename}`).catch(() => undefined);
    }
    const updated = await prisma.tryOnHistory.update({
      where: { id: record.id },
      data: {
        resultImageUrl: null,
        flagged: true,
        flagReason: 'Result removed by admin',
        flaggedAt: new Date(),
      },
      include: REQUEST_INCLUDE,
    });
    res.json({ success: true, data: toRow(updated) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// CSV export — the filtered set, ready for a spreadsheet
// ---------------------------------------------------------------------------

const CSV_ROW_CAP = 5000;

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

adminTryonRouter.get('/export', async (req, res, next) => {
  try {
    const query = req.query as Record<string, unknown>;
    const range = parseRange(query);
    const base = await buildWhere(query, range);
    const where = applyTab(base, typeof query.tab === 'string' ? query.tab : 'RECENT');

    const records = await prisma.tryOnHistory.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: CSV_ROW_CAP,
      include: REQUEST_INCLUDE,
    });

    const header = [
      'Request ID',
      'Created at',
      'Status',
      'Provider',
      'User',
      'Phone',
      'Product',
      'Category',
      'Size',
      'Colour',
      'Device',
      'Duration (s)',
      'Cost (INR)',
      'Feedback',
      'Flagged',
      'Error',
    ];
    const lines = [header.join(',')];
    for (const r of records) {
      const row = toRow(r);
      lines.push(
        [
          row.requestId,
          row.createdAt,
          row.status,
          row.provider,
          row.userName ?? '',
          row.userPhone,
          row.productTitle,
          row.categoryName,
          row.variantSize ?? '',
          row.variantColor ?? '',
          row.deviceType ?? '',
          row.durationMs != null ? (row.durationMs / 1000).toFixed(2) : '',
          (row.costPaise / 100).toFixed(2),
          row.feedback ?? '',
          row.flagged ? 'YES' : 'NO',
          row.errorMessage ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="clowe-tryon-${dayKey(range.from)}-to-${dayKey(range.to)}.csv"`,
    );
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Model settings & usage limits
// ---------------------------------------------------------------------------

async function currentSettings(): Promise<AdminTryOnSettings> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [settings, month] = await Promise.all([
    getSettings(),
    prisma.tryOnHistory.aggregate({
      _sum: { costPaise: true },
      _count: { _all: true },
      where: { createdAt: { gte: monthStart } },
    }),
  ]);
  return {
    enabled: settings.tryonEnabled,
    dailyLimitPerUser: settings.tryonDailyLimit,
    minPricePaise: settings.tryonMinPricePaise,
    monthlyBudgetPaise: settings.tryonMonthlyBudgetPaise,
    provider: tryOnProvider.name,
    costPaisePerRun: tryOnProvider.costPaise,
    monthSpendPaise: month._sum.costPaise ?? 0,
    monthRuns: month._count._all,
  };
}

adminTryonRouter.get('/settings', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await currentSettings() });
  } catch (err) {
    next(err);
  }
});

adminTryonRouter.put('/settings', async (req, res, next) => {
  try {
    const input = adminTryOnSettingsSchema.parse(req.body);
    if (input.enabled !== undefined) await setSetting('tryonEnabled', input.enabled);
    if (input.dailyLimitPerUser !== undefined) {
      await setSetting('tryonDailyLimit', input.dailyLimitPerUser);
    }
    if (input.minPricePaise !== undefined) {
      await setSetting('tryonMinPricePaise', input.minPricePaise);
    }
    if (input.monthlyBudgetPaise !== undefined) {
      await setSetting('tryonMonthlyBudgetPaise', input.monthlyBudgetPaise);
    }
    res.json({ success: true, data: await currentSettings() });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Filter options (providers + categories that actually have try-on data)
// ---------------------------------------------------------------------------

adminTryonRouter.get('/filters', async (_req, res, next) => {
  try {
    const [providers, categories] = await Promise.all([
      prisma.tryOnHistory.groupBy({ by: ['provider'], _count: { _all: true } }),
      prisma.category.findMany({
        where: { isActive: true },
        orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }],
        select: { id: true, name: true, parentId: true },
      }),
    ]);
    res.json({
      success: true,
      data: {
        providers: providers
          .map((p) => ({ provider: p.provider, count: p._count._all }))
          .sort((a, b) => b.count - a.count),
        categories: categories.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId })),
      },
    });
  } catch (err) {
    next(err);
  }
});
