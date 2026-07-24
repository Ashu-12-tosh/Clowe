import { Router } from 'express';
import type { CategoryNode } from '@clowe/shared';
import { prisma } from '../db';

export const categoriesRouter = Router();

// Full active category tree (roots with children), for nav + filters.
categoriesRouter.get('/', async (_req, res, next) => {
  try {
    const categories = await prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    const byParent = new Map<string | null, typeof categories>();
    for (const cat of categories) {
      const list = byParent.get(cat.parentId) ?? [];
      list.push(cat);
      byParent.set(cat.parentId, list);
    }

    const toNode = (cat: (typeof categories)[number]): CategoryNode => ({
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      imageUrl: cat.imageUrl,
      children: (byParent.get(cat.id) ?? []).map(toNode),
    });

    const tree = (byParent.get(null) ?? []).map(toNode);
    res.json({ success: true, data: tree });
  } catch (err) {
    next(err);
  }
});
