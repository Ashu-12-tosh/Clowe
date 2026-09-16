import { Router } from 'express';
import {
  searchAnalyticsQuerySchema,
  type SearchAnalyticsView,
  type SearchQueryStat,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';

export const adminSearchRouter = Router();
adminSearchRouter.use(requireAuth, requireRole('ADMIN'));

/**
 * What shoppers looked for, and what the catalog failed to answer.
 *
 * The zero-result list is the useful half: each entry is somebody who wanted
 * something and found nothing. Working down it — adding a synonym, fixing a
 * title, stocking a gap — is how search gets better over time.
 *
 * The underlying rows hold nothing identifying, so nothing here can be broken
 * down by person, and that is deliberate.
 */
adminSearchRouter.get('/analytics', async (req, res, next) => {
  try {
    const { days, limit } = searchAnalyticsQuerySchema.parse(req.query);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [total, zeroResult, relaxed, trigram, zeroGroups, topGroups] = await Promise.all([
      prisma.searchQuery.count({ where: { createdAt: { gte: since } } }),
      prisma.searchQuery.count({ where: { createdAt: { gte: since }, resultCount: 0 } }),
      prisma.searchQuery.count({ where: { createdAt: { gte: since }, relaxed: true } }),
      prisma.searchQuery.count({ where: { createdAt: { gte: since }, strategy: 'trigram' } }),
      prisma.searchQuery.groupBy({
        by: ['normalized'],
        where: { createdAt: { gte: since }, resultCount: 0 },
        _count: { _all: true },
        _max: { createdAt: true },
        orderBy: { _count: { normalized: 'desc' } },
        take: limit,
      }),
      prisma.searchQuery.groupBy({
        by: ['normalized'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _max: { createdAt: true },
        orderBy: { _count: { normalized: 'desc' } },
        take: limit,
      }),
    ]);

    /**
     * groupBy gives counts but not a readable spelling, so one recent row per
     * group is fetched for display. Capped by `limit`, so this is bounded.
     */
    async function decorate(
      groups: { normalized: string; _count: { _all: number }; _max: { createdAt: Date | null } }[],
    ): Promise<SearchQueryStat[]> {
      return Promise.all(
        groups.map(async (group) => {
          const latest = await prisma.searchQuery.findFirst({
            where: { normalized: group.normalized, createdAt: { gte: since } },
            orderBy: { createdAt: 'desc' },
            select: { query: true, strategy: true, createdAt: true },
          });
          return {
            normalized: group.normalized,
            sample: latest?.query ?? group.normalized,
            count: group._count._all,
            lastSeen: (group._max.createdAt ?? latest?.createdAt ?? since).toISOString(),
            strategy: latest?.strategy ?? 'none',
          };
        }),
      );
    }

    const body: SearchAnalyticsView = {
      days,
      summary: { total, zeroResult, relaxed, trigram },
      zeroResultQueries: await decorate(zeroGroups),
      topQueries: await decorate(topGroups),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
