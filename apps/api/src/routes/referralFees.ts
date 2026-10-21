import { Router } from 'express';
import { z } from 'zod';
import { parseSlabLabel, slabGaps } from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { auditSafe } from '../services/auditService';
import { scheduleTable } from '../services/referralFees/views';
import { applyCategoryMapping, createScheduleVersion, ratesOfVersion } from '../services/referralFees/apply';

// ---------------------------------------------------------------------------
// The referral fee schedule: the version in force for anyone to read (the
// Referral Fee Schedule page), and for admins every version, the category
// mapping, and edits — an edit never changes a stored version: it saves a new
// one, in force from when the admin says (now by default), so order lines
// placed under the old rates keep them.
// ---------------------------------------------------------------------------

export const referralFeesRouter = Router();

referralFeesRouter.get('/', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await scheduleTable() });
  } catch (err) {
    next(err);
  }
});

export const adminReferralFeesRouter = Router();
adminReferralFeesRouter.use(requireAuth, requireRole('ADMIN'));

adminReferralFeesRouter.get('/', async (req, res, next) => {
  try {
    const version = req.query.version ? z.coerce.number().int().min(1).parse(req.query.version) : undefined;
    const [versions, table, categories] = await Promise.all([
      prisma.referralFeeSchedule.findMany({
        orderBy: { version: 'desc' },
        select: { version: true, source: true, effectiveFrom: true, note: true, createdAt: true, _count: { select: { rates: true } } },
      }),
      version ? scheduleTable(version) : prisma.referralFeeSchedule.findFirst({ orderBy: { version: 'desc' }, select: { version: true } }).then((v) => (v ? scheduleTable(v.version) : null)),
      prisma.category.findMany({
        select: { id: true, slug: true, name: true, parentId: true, isActive: true, referralPercent: true, referralFeeCategory: true },
        orderBy: { slug: 'asc' },
      }),
    ]);
    const now = Date.now();
    const inForce = versions.find((v) => v.effectiveFrom.getTime() <= now)?.version ?? null;
    res.json({
      success: true,
      data: {
        versions: versions.map((v) => ({ version: v.version, source: v.source, effectiveFrom: v.effectiveFrom.toISOString(), note: v.note, createdAt: v.createdAt.toISOString(), rates: v._count.rates, inForce: v.version === inForce })),
        table,
        categories,
      },
    });
  } catch (err) {
    next(err);
  }
});

const rateEditSchema = z.object({
  /** The version the edit starts from. */
  baseVersion: z.number().int().min(1),
  sheetCategory: z.string().trim().min(1).max(300),
  /** The category's full set of slabs after the edit. */
  slabs: z
    .array(z.object({ label: z.string().trim().min(1).max(60), ratePercent: z.number().min(0).max(100) }))
    .min(1)
    .max(12),
  effectiveFrom: z.coerce.date().optional(),
  note: z.string().trim().min(3, 'Say why the rate changes').max(300),
});

// One category's slabs changed: a new version with everything else as it was.
adminReferralFeesRouter.post('/versions', async (req, res, next) => {
  try {
    const input = rateEditSchema.parse(req.body);
    const effectiveFrom = input.effectiveFrom ?? new Date();
    if (effectiveFrom.getTime() < Date.now() - 60_000) throw ApiError.badRequest('A new rate can only apply from now on — orders already placed keep their fees');
    const base = await ratesOfVersion(input.baseVersion);
    const own = base.filter((r) => r.sheetCategory === input.sheetCategory);
    if (own.length === 0) throw ApiError.notFound(`"${input.sheetCategory}" is not in version ${input.baseVersion}`);
    const slabs = input.slabs.map((s) => {
      const bounds = parseSlabLabel(s.label);
      if (!bounds) throw ApiError.badRequest(`Slab "${s.label}" — write it as "<= 1,000", "> 1,000", "> 250 and <= 500" or "All prices"`);
      if (Math.round(s.ratePercent * 100) !== s.ratePercent * 100) throw ApiError.badRequest('Rates go to two decimal places at most');
      return { ...bounds, label: s.label, rateBps: Math.round(s.ratePercent * 100) };
    });
    const gaps = slabGaps(slabs);
    if (gaps.length) throw ApiError.badRequest('The slabs must cover every price from ₹0 up, without gaps or overlaps');
    const sorted = [...slabs].sort((a, b) => a.abovePaise - b.abovePaise);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i - 1]!.upToPaise === null || sorted[i]!.abovePaise !== sorted[i - 1]!.upToPaise) throw ApiError.badRequest('The slabs must cover every price from ₹0 up, without gaps or overlaps');
    }
    const group = own[0]!.group;
    const at = base.findIndex((r) => r.sheetCategory === input.sheetCategory);
    const rates = [
      ...base.slice(0, at),
      ...sorted.map((s) => ({ group, sheetCategory: input.sheetCategory, slabLabel: s.label, abovePaise: s.abovePaise, upToPaise: s.upToPaise, rateBps: s.rateBps, benchmarkBps: null, borrowedFrom: null })),
      ...base.slice(at).filter((r) => r.sheetCategory !== input.sheetCategory),
    ];
    const created = await createScheduleVersion({ rates, source: 'Admin edit', effectiveFrom, createdById: req.auth!.userId, note: input.note });
    auditSafe({
      actorId: req.auth!.userId,
      actorRole: 'ADMIN',
      module: 'SETTINGS',
      action: 'Referral fee rates changed',
      entityType: 'ReferralFeeSchedule',
      entityId: created.id,
      summary: `Referral fees v${created.version}: "${input.sheetCategory}" from ${effectiveFrom.toISOString()}`,
      metadata: { baseVersion: input.baseVersion, before: own.map((r) => [r.slabLabel, r.rateBps]), after: sorted.map((s) => [s.label, s.rateBps]), note: input.note },
      severity: 'HIGH',
    });
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    next(err);
  }
});

const mappingSchema = z.object({ sheetCategory: z.string().trim().min(1).max(300).nullable() });

// A category's schedule category (null = as its parent / the flat rate).
adminReferralFeesRouter.put('/mapping/:categoryId', async (req, res, next) => {
  try {
    const { sheetCategory } = mappingSchema.parse(req.body);
    const category = await prisma.category.findUnique({ where: { id: req.params.categoryId }, select: { id: true, slug: true } });
    if (!category) throw ApiError.notFound('Category not found');
    if (sheetCategory) {
      const known = await prisma.referralFeeRate.count({ where: { sheetCategory } });
      if (!known) throw ApiError.badRequest(`"${sheetCategory}" is not a category in the fee schedule`);
    }
    const [change] = await applyCategoryMapping([{ categoryId: category.id, sheetCategory }]);
    auditSafe({
      actorId: req.auth!.userId,
      actorRole: 'ADMIN',
      module: 'SETTINGS',
      action: 'Referral fee category changed',
      entityType: 'Category',
      entityId: category.id,
      summary: `${category.slug}: ${change!.before ?? 'none'} → ${sheetCategory ?? 'none'}`,
      metadata: { before: change!.before, after: sheetCategory },
      severity: 'HIGH',
    });
    res.json({ success: true, data: change });
  } catch (err) {
    next(err);
  }
});
