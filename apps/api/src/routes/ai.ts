import { Router } from 'express';
import {
  aiDescriptionSchema,
  searchIntentSchema,
  supportChatSchema,
  findHelpArticles,
  sellerAssistantSchema,
  type ReviewSummaryView,
  type SearchIntent,
  type SellerAssistantReply,
} from '@clowe/shared';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { ApiError } from '../utils/ApiError';
import { aiProvider } from '../services/ai';
import { aiLimiter } from '../middleware/rateLimits';

export const aiRouter = Router();
aiRouter.use(aiLimiter);

/** Pull the first JSON object out of a model reply (tolerates prose around it). */
function extractJson(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Product description generator (sellers)
// ---------------------------------------------------------------------------

aiRouter.post('/product-description', requireAuth, async (req, res, next) => {
  try {
    const input = aiDescriptionSchema.parse(req.body);
    const description = await aiProvider.complete({
      task: 'product-description',
      system:
        'You write product descriptions for Clowe, an Indian online marketplace that sells everything from electronics and home appliances to fashion, books and groceries. Match the tone and vocabulary to the product category given. ' +
        'Write one paragraph of 60-100 words: warm, concrete, benefit-led, no emojis, no headings, ' +
        'no invented specifications (only use the details provided). Plain text only.',
      user: JSON.stringify(input),
      maxTokens: 1024,
    });
    res.json({ success: true, data: { description, provider: aiProvider.name } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 2. Review summary (public, cached 1h per product)
// ---------------------------------------------------------------------------

const MIN_REVIEWS_FOR_SUMMARY = 3;
const summaryCache = new Map<string, { view: ReviewSummaryView; count: number; expires: number }>();

aiRouter.get('/review-summary/:productId', async (req, res, next) => {
  try {
    const { productId } = req.params;
    const agg = await prisma.review.aggregate({
      where: { productId },
      _avg: { rating: true },
      _count: { rating: true },
    });
    const ratingCount = agg._count.rating;
    const ratingAvg = agg._avg.rating;

    if (ratingCount < MIN_REVIEWS_FOR_SUMMARY) {
      const view: ReviewSummaryView = {
        summary: null,
        ratingAvg,
        ratingCount,
        provider: aiProvider.name,
      };
      return res.json({ success: true, data: view });
    }

    const cached = summaryCache.get(productId);
    if (cached && cached.expires > Date.now() && cached.count === ratingCount) {
      return res.json({ success: true, data: cached.view });
    }

    const reviews = await prisma.review.findMany({
      where: { productId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { rating: true, comment: true },
    });
    const summary = await aiProvider.complete({
      task: 'review-summary',
      system:
        'You summarize customer reviews for a product page on Clowe, an Indian online marketplace. ' +
        'Write 2-3 sentences capturing overall sentiment, what buyers praise, and any recurring complaint. ' +
        'Be balanced and specific. Plain text only.',
      user: JSON.stringify({
        ratingAvg,
        ratingCount,
        positiveCount: reviews.filter((r) => r.rating >= 4).length,
        sampleComments: reviews.map((r) => r.comment).filter(Boolean).slice(0, 15),
        ratings: reviews.map((r) => r.rating),
      }),
      maxTokens: 512,
    });

    const view: ReviewSummaryView = { summary, ratingAvg, ratingCount, provider: aiProvider.name };
    summaryCache.set(productId, { view, count: ratingCount, expires: Date.now() + 60 * 60 * 1000 });
    res.json({ success: true, data: view });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 3. Voice search intent (public)
// ---------------------------------------------------------------------------

aiRouter.post('/search-intent', async (req, res, next) => {
  try {
    const { transcript } = searchIntentSchema.parse(req.body);
    const categories = await prisma.category.findMany({
      where: { isActive: true },
      select: { name: true, slug: true },
    });

    const reply = await aiProvider.complete({
      task: 'search-intent',
      system:
        'You convert a spoken shopping query into JSON search filters for an online marketplace (electronics, mobiles, fashion, home, beauty, books, grocery and more). ' +
        'Reply with ONLY a JSON object: {"q": string, "category": string|null, "maxPrice": number|null, "colors": string[]}. ' +
        '"category" must be one of the provided slugs or null. "maxPrice" is in rupees. ' +
        '"q" is the cleaned search text (keep product words such as brand, model, material or spec; drop filler and filter words).',
      user: JSON.stringify({ transcript, categories }),
      maxTokens: 512,
    });

    const parsed = extractJson(reply);
    const validSlugs = new Set(categories.map((c) => c.slug));
    const intent: SearchIntent = {
      q: typeof parsed?.q === 'string' ? parsed.q : transcript,
      category:
        typeof parsed?.category === 'string' && validSlugs.has(parsed.category)
          ? parsed.category
          : null,
      // The prompt asks for rupees; this is the one place it becomes paise.
      maxPricePaise:
        typeof parsed?.maxPrice === 'number' && parsed.maxPrice > 0
          ? Math.round(parsed.maxPrice) * 100
          : null,
      colors: Array.isArray(parsed?.colors) ? (parsed.colors as string[]).slice(0, 4) : [],
    };
    res.json({ success: true, data: intent });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 4. Support chat (public, lightly rate-limited per IP)
// ---------------------------------------------------------------------------

const chatUsage = new Map<string, { count: number; day: string }>();
const CHAT_DAILY_LIMIT = 50;

aiRouter.post('/support-chat', async (req, res, next) => {
  try {
    const { messages } = supportChatSchema.parse(req.body);

    const ip = req.ip ?? 'unknown';
    const today = new Date().toDateString();
    const usage = chatUsage.get(ip);
    const count = usage?.day === today ? usage.count : 0;
    if (count >= CHAT_DAILY_LIMIT) {
      throw ApiError.tooMany('Chat limit reached for today. Please try again tomorrow.');
    }
    chatUsage.set(ip, { count: count + 1, day: today });

    const reply = await aiProvider.complete({
      task: 'support-chat',
      system:
        'You are the customer support assistant for Clowe, an Indian multi-vendor online marketplace. ' +
        'Facts: shipping free at/above ₹999 else ₹49, delivery 3-7 days; orders cancellable until shipped; ' +
        'returns via Orders page after delivery, refunds after seller receives the item; payments via Razorpay (UPI/cards/netbanking); ' +
        'AI "Try On Me" on every product page (upload a photo, 10/day free); sellers register via the Sell page and are approved by admin. ' +
        'Answer briefly and warmly in the language the customer writes in (English or Hinglish). ' +
        'If asked something outside Clowe support, politely steer back. Never invent order details — point users to their Orders page.',
      user: JSON.stringify({
        lastMessage: messages[messages.length - 1].content,
        history: messages.slice(-10),
      }),
      maxTokens: 1024,
    });
    res.json({ success: true, data: { reply, provider: aiProvider.name } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// 5. Seller assistant — grounded in the seller handbook
// ---------------------------------------------------------------------------

const SELLER_CHAT_DAILY_LIMIT = 100;
const sellerChatUsage = new Map<string, { count: number; day: string }>();

aiRouter.post('/seller-assistant', requireAuth, async (req, res, next) => {
  try {
    const input = sellerAssistantSchema.parse(req.body);

    const userId = req.auth!.userId;
    const today = new Date().toDateString();
    const usage = sellerChatUsage.get(userId);
    const count = usage?.day === today ? usage.count : 0;
    if (count >= SELLER_CHAT_DAILY_LIMIT) {
      throw ApiError.tooMany('Assistant limit reached for today. Please try again tomorrow.');
    }
    sellerChatUsage.set(userId, { count: count + 1, day: today });

    // Ground the answer in the handbook so it can't contradict the docs.
    const articles = findHelpArticles(input.question, 3);

    const answer = await aiProvider.complete({
      task: 'seller-assistant',
      system:
        'You are the seller assistant for Clowe, an Indian multi-vendor marketplace. ' +
        'Answer ONLY from the handbook articles provided. If they do not cover the question, say so ' +
        'and suggest raising a support ticket — never invent policy, fees, timelines or numbers. ' +
        'Be concise and practical: name the exact page or button in the seller panel where relevant. ' +
        "Never quote a seller's own figures — you cannot see their data.",
      user: JSON.stringify({
        question: input.question,
        history: input.history.slice(-6),
        articles: articles.map((a) => ({ id: a.id, title: a.title, body: a.body })),
      }),
      maxTokens: 1024,
    });

    const body: SellerAssistantReply = {
      answer,
      provider: aiProvider.name,
      sources: articles.map((a) => ({ id: a.id, title: a.title })),
    };
    res.json({ success: true, data: body });
  } catch (err) {
    next(err);
  }
});
