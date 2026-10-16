import { Router } from 'express';
import { z } from 'zod';
import {
  aiSearchSchema,
  compareIdsSchema,
  compareSummarySchema,
  normaliseAttributes,
  planAllows,
  type AiSearchFilters,
  type AiSearchResult,
  type CompareProduct,
  type CompareView,
  type ProductListItem,
  type ProductListResponse,
} from '@clowe/shared';
import { prisma } from '../db';
import { env } from '../env';
import { optionalAuth } from '../middleware/auth';
import { aiLimiter } from '../middleware/rateLimits';
import { aiCall, aiUserKey, AiUnavailable } from '../services/aiMeter';
import { categoryRulesFor, returnWindowDaysFor } from '../services/categoryRules';
import { getCommercial } from '../services/commercial';
import { returnableFor } from '../services/returnability';
import { LIVE_PRODUCT_WHERE } from '../services/productSearch';
import { visibleProductWhere } from '../services/shopperVisibility';
import { productListItemInclude, toProductListItem } from '../utils/productListing';

// ---------------------------------------------------------------------------
// AI Search, Compare and recommendations (owner's overnight run). The model
// only ever turns words into filters, or writes about data we hand it: every
// product, price and spec on these pages comes from our catalog. If AI is
// unavailable (budget, limit, error) the pages still work without it.
// ---------------------------------------------------------------------------

export const aiShoppingRouter = Router();

/** The storefront's own listing (relevance, filters, visibility), asked over loopback. */
async function listing(port: number, params: Record<string, string | number | undefined>): Promise<ProductListItem[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== null) qs.set(k, String(v));
  const res = await fetch(`http://127.0.0.1:${port}/api/products?${qs}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];
  return ((await res.json()) as { data?: ProductListResponse }).data?.items ?? [];
}

/** The port this request came in on: the listing is asked on the same server. */
const portOf = (req: import('express').Request) => req.socket.localPort ?? env.PORT;

/** "₹1,179" — whole rupees, Indian grouping, as the shopper sees prices. */
const rupeesText = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

const numberIn = (text: string) => new Set((text.match(/\d[\d,]*/g) ?? []).map((n) => n.replace(/,/g, '')));

// --- AI Search -------------------------------------------------------------------------

aiShoppingRouter.get('/search', aiLimiter, optionalAuth, async (req, res, next) => {
  try {
    const { q: query } = aiSearchSchema.parse(req.query);
    const categories = await prisma.category.findMany({
      where: { isActive: true, ...(await categoryVisibleWhere()) },
      select: { name: true, slug: true, parent: { select: { name: true } } },
      orderBy: { sortOrder: 'asc' },
      take: 120,
    });
    let filters: AiSearchFilters = { q: query, category: null, minPricePaise: null, maxPricePaise: null, colors: [] };
    let answer: string | null = null;
    let ai = true;
    try {
      const reply = await aiCall({
        userKey: aiUserKey(req),
        exempt: req.auth?.role === 'ADMIN',
        task: 'ai-search',
        json: true,
        maxTokens: 300,
        system:
          'You turn a shopper\'s question into search filters for Clowe, an Indian online marketplace. ' +
          'Reply with ONLY a JSON object: {"q": string, "category": string|null, "minPrice": number|null, "maxPrice": number|null, "colors": string[], "answer": string}. ' +
          '"q" is the product words to search for (brand, product type, material, spec) without filler or price words. ' +
          '"category" must be one of the given slugs, or null when unsure. Prices are in rupees and only when the shopper gave them. ' +
          '"answer" is ONE short sentence restating what the shopper is looking for, e.g. "Cotton kurtas for women under ₹1,500." ' +
          'Never name products, brands, prices or features the shopper did not say; you cannot see the catalog.',
        user: JSON.stringify({ query, categories: categories.map((c) => ({ slug: c.slug, name: c.parent ? `${c.parent.name} › ${c.name}` : c.name })) }),
      });
      const parsed = JSON.parse(reply.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as Record<string, unknown>;
      const slugs = new Set(categories.map((c) => c.slug));
      const rupees = (v: unknown) => (typeof v === 'number' && v > 0 && v < 10_000_000 ? Math.round(v) * 100 : null);
      filters = {
        q: typeof parsed.q === 'string' && parsed.q.trim() ? parsed.q.trim().slice(0, 100) : query.slice(0, 100),
        category: typeof parsed.category === 'string' && slugs.has(parsed.category) ? parsed.category : null,
        minPricePaise: rupees(parsed.minPrice),
        maxPricePaise: rupees(parsed.maxPrice),
        colors: Array.isArray(parsed.colors) ? parsed.colors.filter((c): c is string => typeof c === 'string').slice(0, 4) : [],
      };
      // The one line may only restate the question: no number the shopper did not give.
      if (typeof parsed.answer === 'string') {
        const said = numberIn(query);
        const line = parsed.answer.trim().slice(0, 160);
        answer = [...numberIn(line)].every((n) => said.has(n)) ? line : null;
      }
    } catch (err) {
      if (!(err instanceof AiUnavailable)) throw err;
      ai = false;
    }

    // The filters, loosened step by step if they find nothing.
    const base = { q: filters.q, limit: 24 };
    const tries: Record<string, string | number | undefined>[] = [
      { ...base, category: filters.category ?? undefined, minPrice: filters.minPricePaise ? filters.minPricePaise / 100 : undefined, maxPrice: filters.maxPricePaise ? filters.maxPricePaise / 100 : undefined, colors: filters.colors.join(',') || undefined },
      { ...base, category: filters.category ?? undefined, maxPrice: filters.maxPricePaise ? filters.maxPricePaise / 100 : undefined },
      { ...base, category: filters.category ?? undefined },
      { ...base },
      { q: query.slice(0, 100), limit: 24 },
    ];
    let found: ProductListItem[] = [];
    for (const t of ai ? tries : [tries[tries.length - 1]!]) {
      found = await listing(portOf(req), t);
      if (found.length) break;
    }

    // AI search visibility is a plan feature: those sellers' products are the
    // AI picks; the same search across every seller follows below them.
    const c = await getCommercial();
    const sellers = await prisma.product.findMany({
      where: { id: { in: found.map((p) => p.id) } },
      select: { id: true, seller: { select: { subscription: { select: { plan: true } } } } },
    });
    const visible = new Set(sellers.filter((s) => planAllows(c, s.seller.subscription?.plan ?? 'FREE', 'AI_SEARCH_VISIBILITY')).map((s) => s.id));
    const body: AiSearchResult = {
      query,
      ai,
      answer: ai ? answer : null,
      filters,
      items: ai ? found.filter((p) => visible.has(p.id)) : [],
      more: ai ? found.filter((p) => !visible.has(p.id)) : found,
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});

async function categoryVisibleWhere() {
  const hidden = (await import('../services/shopperVisibility')).shopperHidden;
  const h = await hidden();
  return h.categoryIds.size ? { id: { notIn: [...h.categoryIds] } } : {};
}

// --- Compare ---------------------------------------------------------------------------

async function compareView(ids: string[]): Promise<CompareView> {
  const rows = await prisma.product.findMany({
    where: { id: { in: ids }, ...LIVE_PRODUCT_WHERE, ...(await visibleProductWhere()) },
    include: { ...productListItemInclude, seller: { select: { shopName: true, returnWindowDays: true } } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const products: CompareProduct[] = [];
  const labels: string[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) continue;
    const item = toProductListItem(p);
    const rules = await categoryRulesFor(p.categoryId);
    const attrs = normaliseAttributes(p.attributes, rules.attributeSchema);
    const attributes: Record<string, string> = {};
    for (const a of attrs) {
      attributes[a.label] = a.value;
      if (!labels.includes(a.label)) labels.push(a.label);
    }
    const returnable = await returnableFor(p.categoryId, p.nonReturnable);
    const days = await returnWindowDaysFor(p.categoryId, p.seller.returnWindowDays);
    products.push({
      id: p.id,
      slug: p.slug,
      title: p.title,
      brand: p.brand,
      imageUrl: item.imageUrl,
      categoryName: item.categoryName,
      pricePaise: item.pricePaise,
      mrpPaise: item.mrpPaise,
      priceVaries: item.priceVaries,
      ratingAvg: item.ratingAvg,
      ratingCount: item.ratingCount,
      sellerName: p.seller.shopName,
      returns: returnable ? `Claim within ${days > 2 ? `${days} days` : '48 hours'} if damaged, defective or wrong` : 'Not returnable',
      attributes,
      inStock: item.inStock,
    });
  }
  return { products, attributeLabels: labels };
}

aiShoppingRouter.get('/compare', async (req, res, next) => {
  try {
    const ids = z.string().max(400).parse(req.query.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const { ids: valid } = compareIdsSchema.parse({ ids: [...new Set(ids)] });
    res.json({ success: true, data: await compareView(valid) });
  } catch (err) {
    next(err);
  }
});

aiShoppingRouter.post('/compare-summary', aiLimiter, optionalAuth, async (req, res, next) => {
  try {
    const input = compareSummarySchema.parse(req.body);
    const view = await compareView([...new Set(input.ids)]);
    if (view.products.length < 2) return res.json({ success: true, data: { summary: null, ai: false, message: 'Pick at least two products to compare.' } });
    try {
      const summary = await aiCall({
        userKey: aiUserKey(req),
        exempt: req.auth?.role === 'ADMIN',
        task: 'compare-summary',
        maxTokens: 400,
        system:
          'You help a shopper on Clowe, an Indian online marketplace, choose between products. Use ONLY the data given for each product ' +
          '(title, price including GST, attributes, seller, returns, rating). Write prices exactly as given (e.g. "₹1,179"). If something the shopper needs is not in the data, say it is not listed. ' +
          'Never invent specs, prices, offers or reviews. Write 3-5 short sentences in plain text, then one line starting "For you:" with a suggestion based on the shopper\'s needs, if given.',
        user: JSON.stringify({
          needs: input.needs ?? null,
          products: view.products.map((p) => ({
            title: p.title,
            brand: p.brand,
            price: rupeesText(p.pricePaise),
            mrp: p.mrpPaise ? rupeesText(p.mrpPaise) : null,
            rating: p.ratingCount ? `${p.ratingAvg?.toFixed(1)} from ${p.ratingCount} ratings` : 'no ratings yet',
            seller: p.sellerName,
            returns: p.returns,
            inStock: p.inStock,
            attributes: p.attributes,
          })),
        }),
      });
      res.json({ success: true, data: { summary, ai: true, message: null } });
    } catch (err) {
      if (!(err instanceof AiUnavailable)) throw err;
      res.json({ success: true, data: { summary: null, ai: false, message: err.message } });
    }
  } catch (err) {
    next(err);
  }
});

// --- Recommendations -------------------------------------------------------------------

const recCache = new Map<string, { ids: string[]; expires: number }>();

/** Products like this one, from its category; the model only reorders our own candidates. */
aiShoppingRouter.get('/recommendations/:productId', async (req, res, next) => {
  try {
    const product = await prisma.product.findFirst({
      where: { id: req.params.productId, ...LIVE_PRODUCT_WHERE },
      select: { id: true, title: true, brand: true, category: { select: { slug: true, name: true } } },
    });
    if (!product) return res.json({ success: true, data: { items: [], ai: false } });
    const candidates = (await listing(portOf(req), { category: product.category.slug, limit: 24 })).filter((p) => p.id !== product.id);
    const cached = recCache.get(product.id);
    let order: string[] | null = cached && cached.expires > Date.now() ? cached.ids : null;
    let ai = !!order;
    if (!order && candidates.length > 2) {
      try {
        const reply = await aiCall({
          task: 'recommendations',
          json: true,
          maxTokens: 200,
          system:
            'You pick which listed products a shopper viewing a product would most likely also want. Reply ONLY JSON {"ids": string[]} with up to 8 ids, ' +
            'chosen ONLY from the candidates given, best first. Prefer close alternatives and things that go well with it.',
          user: JSON.stringify({ viewing: { title: product.title, brand: product.brand, category: product.category.name }, candidates: candidates.map((c) => ({ id: c.id, title: c.title, brand: c.brand, priceRupees: c.pricePaise / 100 })) }),
        });
        const ids = (JSON.parse(reply.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { ids?: unknown }).ids;
        const known = new Set(candidates.map((c) => c.id));
        order = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && known.has(id)).slice(0, 8) : [];
        ai = order.length > 0;
        if (ai) recCache.set(product.id, { ids: order, expires: Date.now() + 24 * 3_600_000 });
      } catch (err) {
        if (!(err instanceof AiUnavailable)) throw err;
        order = null;
      }
    }
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const items = order && order.length ? order.map((id) => byId.get(id)).filter((p): p is ProductListItem => !!p) : candidates.slice(0, 8);
    res.json({ success: true, data: { items, ai } });
  } catch (err) {
    next(err);
  }
});
