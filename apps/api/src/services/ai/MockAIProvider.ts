import type { AIProvider, AiCompleteInput } from './AIProvider';

/**
 * Free dev provider: deterministic templates + keyword heuristics so every AI
 * feature is testable without an API key. The user prompt for each task is a
 * JSON payload (built by routes/ai.ts) that this provider parses.
 */
export class MockAIProvider implements AIProvider {
  readonly name = 'mock';

  async complete(input: AiCompleteInput): Promise<string> {
    const payload = safeParse(input.user);
    switch (input.task) {
      case 'product-description':
        return this.productDescription(payload);
      case 'review-summary':
        return this.reviewSummary(payload);
      case 'search-intent':
        return this.searchIntent(payload);
      case 'support-chat':
        return this.supportChat(payload);
    }
  }

  private productDescription(p: Record<string, unknown>): string {
    const title = String(p.title ?? 'This piece');
    const brand = p.brand ? ` by ${p.brand}` : '';
    const category = p.categoryName ? ` A wardrobe essential in our ${p.categoryName} range.` : '';
    const keywords = p.keywords
      ? ` Crafted with ${String(p.keywords).toLowerCase()} in mind.`
      : '';
    return (
      `${title}${brand} — designed for everyday comfort with a premium feel.${category}${keywords} ` +
      `Made from quality fabric that stays soft wash after wash, with attention to stitching and fit. ` +
      `Pairs effortlessly with your existing wardrobe, from casual outings to relaxed workdays. ` +
      `Machine washable, colour-fast, and true to size — order your usual size for the best fit.`
    );
  }

  private reviewSummary(p: Record<string, unknown>): string {
    const avg = Number(p.ratingAvg ?? 0);
    const count = Number(p.ratingCount ?? 0);
    const positives = Number(p.positiveCount ?? 0);
    const mood =
      avg >= 4.2 ? 'love' : avg >= 3.5 ? 'generally like' : 'have mixed feelings about';
    const highlights = Array.isArray(p.sampleComments)
      ? (p.sampleComments as string[]).slice(0, 2).map((c) => `"${c.slice(0, 60)}"`)
      : [];
    return (
      `Customers ${mood} this product (${avg.toFixed(1)}★ from ${count} reviews). ` +
      `${positives} of ${count} buyers rated it 4★ or above, frequently praising the fit and fabric quality.` +
      (highlights.length ? ` Typical feedback: ${highlights.join(' and ')}.` : '')
    );
  }

  private searchIntent(p: Record<string, unknown>): string {
    const transcript = String(p.transcript ?? '').toLowerCase();
    const categories = (p.categories ?? []) as { name: string; slug: string }[];

    // Price: "under 1500", "below ₹2000", "1500 rupees se kam"
    const priceMatch = transcript.match(/(?:under|below|less than|upto|up to)\s*(?:rs\.?|₹|rupees)?\s*(\d{2,6})/);
    const maxPrice = priceMatch ? Number(priceMatch[1]) : null;

    const COLORS = ['black', 'white', 'blue', 'navy', 'red', 'green', 'pink', 'yellow', 'grey', 'purple', 'olive', 'beige', 'maroon', 'teal', 'wine'];
    const colors = COLORS.filter((c) => transcript.includes(c)).map(
      (c) => c[0].toUpperCase() + c.slice(1),
    );

    // Category: longest matching category name wins (e.g. "dresses" → women-dresses).
    let category: string | null = null;
    let bestLen = 0;
    for (const cat of categories) {
      const name = cat.name.toLowerCase().replace(/-/g, ' ');
      const tokens = [name, name.replace(/s$/, ''), name.replace(/e?s$/, '')];
      for (const token of tokens) {
        if (token.length > 2 && transcript.includes(token) && token.length > bestLen) {
          category = cat.slug;
          bestLen = token.length;
        }
      }
    }

    // Query: transcript minus filler + matched filter words.
    const q = transcript
      .replace(/(?:under|below|less than|upto|up to)\s*(?:rs\.?|₹|rupees)?\s*\d{2,6}/g, '')
      .replace(/\b(show me|find|search for|search|i want|get me|please|for|me|some)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return JSON.stringify({ q, category, maxPrice, colors });
  }

  private supportChat(p: Record<string, unknown>): string {
    const lastMessage = String(p.lastMessage ?? '').toLowerCase();
    const rules: [RegExp, string][] = [
      [/track|kaha|where.*order|status/, 'You can track every order from the "Orders" page (top menu after login). Each item shows its live status — Confirmed, Shipped, or Delivered.'],
      [/return|refund|exchange|wapas/, 'Returns are easy! Once an item is Delivered, open Orders → your order → "Request return" on that item and tell us why. Refunds for paid orders are processed after the seller receives the item back.'],
      [/cancel/, 'You can cancel an order any time before it ships: Orders → open the order → "Cancel order". Stock and payment are released immediately.'],
      [/ship|delivery|charge|kitna time/, 'Shipping is FREE on orders of ₹999 or more; below that a flat ₹49 applies. Sellers usually ship within 1–2 days and delivery takes 3–7 days depending on your pincode.'],
      [/try.?on|photo|virtual/, 'Try On Me ✨ lets you see clothes on yourself! Open any product, tap "Try On Me", upload a full-body photo, and our AI generates a preview. You get 10 try-ons per day.'],
      [/sell|seller|shop kholna|register.*shop/, 'To sell on Clowe: login, click "Sell" in the header, and submit your shop details. Our team reviews every application, and once approved you can list products right away.'],
      [/pay|payment|upi|card|razorpay/, 'We accept UPI, cards, and netbanking via Razorpay. Payment is confirmed instantly and your order moves to Confirmed status.'],
      [/size|fit/, 'Every product page lists available sizes per colour — sizes with a line through them are out of stock. Check the product description for fit notes (slim/regular/oversized).'],
      [/hello|hi|hey|namaste/, 'Hi! 👋 I\'m the Clowe assistant. Ask me about orders, returns, shipping, payments, AI try-on, or selling on Clowe.'],
    ];
    for (const [pattern, answer] of rules) {
      if (pattern.test(lastMessage)) return answer;
    }
    return 'I can help with orders, returns, shipping, payments, the AI try-on, and becoming a seller. Could you tell me a bit more about what you need?';
  }
}

function safeParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}
