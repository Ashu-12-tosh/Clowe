import { createHash } from 'node:crypto';
import {
  QUERY_SUGGESTION_LIMIT,
  SEARCH_SYNONYMS,
  SUGGESTION_INTENT_WORDS,
  normalizeSuggestInput,
  type ParsedSearchQuery,
  type QuerySuggestion,
} from '@clowe/shared';
import { prisma } from '../db';
import { descendantIds } from './categoryRules';
import { LIVE_PRODUCT_WHERE, searchCatalog, searchProducts } from './productSearch';
import {
  categoryWords,
  formatRupeesForQuery,
  priceBucketsPaise,
} from './suggestionPhrasing';

/**
 * Query suggestions: the phrase layer of the search dropdown.
 *
 * Amazon completes "best" into "best phone under 20k" because a great many
 * people have searched exactly that. This catalog has a few hundred products
 * and a search log a few days old, so most phrases are built from the catalog
 * instead — the parser's intent words, product words and brands that exist,
 * and price bounds taken from what things actually cost. Logged searches rank
 * above everything built, so as real queries pile up they take the list over
 * without anything here changing.
 *
 * One rule holds for every phrase, whatever its source: before it can be
 * suggested it is run through searchProducts, the results page's own search,
 * and it has to come back with products, matched as written, and narrower than
 * the whole catalog. A suggestion that opens an empty or meaningless page is
 * the original zero-results bug in a new costume.
 *
 * All of that happens in the background, on a timer. A keystroke only ever
 * scans the finished list.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** How often the phrase set is rebuilt. The catalog changes slowly. */
const REFRESH_MS = 15 * 60 * 1000;

/**
 * Searches a logged query needs before anyone else is shown it.
 *
 * Suggesting one shopper's text to every other shopper is publishing it, and
 * the log deliberately holds no identity, so this cannot count distinct
 * people — one person searching three times meets it. The stronger guard is
 * verification: a phrase survives only if it matches product text or names a
 * catalog brand or price, so a name or a phone number typed into the box can
 * never come back out as a suggestion.
 */
export const MIN_LOGGED_SEARCHES = 3;

/**
 * Share of a category-derived word's results that must sit in that category.
 * Keeps a generic word from a compound name — "home" out of "Home & Kitchen" —
 * from being offered because it happens to appear in a few titles.
 */
const MIN_CATEGORY_COHERENCE = 0.5;

/**
 * Share of a built phrase's results whose TITLE names what the phrase names.
 *
 * Full-text search also reads descriptions, which is right for the results
 * page and wrong for a suggestion. This catalog sells no washing machines, yet
 * "washing machine under 2k" returns 21 products — clothes whose care
 * instructions say "machine wash". The phrase passes every other check and is
 * still a lie; requiring the word in most titles is what catches it.
 */
const MIN_TITLE_COHERENCE = 0.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RejectReason =
  /** Nothing came back. */
  | 'empty'
  /** Only came back after the search dropped a filter the phrase names. */
  | 'relaxed'
  /** Only came back through typo tolerance: the words as written match nothing. */
  | 'typo'
  /** Came back with the whole catalog reordered — the phrase filtered nothing. */
  | 'no-narrowing'
  /**
   * Results that are mostly not the thing named: outside the category the word
   * came from, or matched on descriptions rather than titles.
   */
  | 'incoherent'
  /** Parsed into something other than what the phrase was built to say. */
  | 'misparsed';

export interface SuggestedPhrase extends QuerySuggestion {
  /** Result count when it was verified. */
  total: number;
  /** Order within its source: times searched if logged, units sold across its results if built. */
  score: number;
  /**
   * How many of its results are titled with its topic word, whole — which
   * decides between wordings of one search. "best headphones" over "best
   * earbud" because that is what the products are called, not because it is
   * shorter.
   */
  wording: number;
  /** Phrases about the same thing share this, so one topic cannot fill the list. */
  topicKey: string;
  /** Phrases that would open the very same page share this, so only one is offered. */
  resultKey: string;
}

export interface QuerySuggestionStats {
  /** Distinct phrases put through the results page's search. */
  verified: number;
  rejected: Record<RejectReason, number>;
  /** Phrases in the finished set. */
  kept: number;
  /** Of those, how many came from the search log. */
  logged: number;
}

export interface QuerySuggestionSnapshot {
  version: number;
  builtAt: Date;
  durationMs: number;
  /** Best first: logged by times searched, then built by units sold. */
  phrases: SuggestedPhrase[];
  stats: QuerySuggestionStats;
}

type Verification =
  | { ok: true; ids: string[]; parsed: ParsedSearchQuery }
  | { ok: false; reason: RejectReason };

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Run a phrase through the results page's own search and decide whether it can
 * be suggested.
 *
 * Exported for tests: the rejection reasons are the contract.
 */
export async function verifyPhrase(phrase: string, liveCount: number): Promise<Verification> {
  const result = await searchProducts({
    raw: phrase,
    baseWhere: LIVE_PRODUCT_WHERE,
    sort: 'popularity',
    skip: 0,
    // Every id, not one page: price bounds and scores are computed from them.
    take: Math.max(liveCount, 1),
  });
  const { meta } = result;

  if (result.total === 0) return { ok: false, reason: 'empty' };
  // "phone under 10k" with nothing under 10k: the page loosens the bound and
  // says so, but the phrase itself would have been a lie.
  if (meta.relaxed) return { ok: false, reason: 'relaxed' };
  if (meta.strategy === 'trigram') return { ok: false, reason: 'typo' };

  // An exact category name parses into a guess that ranks and never filters,
  // leaving no words to search — so "smartphones" "returns" all 245 products.
  // Non-empty, and still meaningless.
  const f = meta.parsed.filters;
  const narrowedByFilter =
    f.brands.length > 0 || f.minPricePaise != null || f.maxPricePaise != null || Boolean(f.onSale);
  if ((meta.strategy !== 'fts' && !narrowedByFilter) || result.total >= liveCount) {
    return { ok: false, reason: 'no-narrowing' };
  }

  return { ok: true, ids: result.ids, parsed: meta.parsed };
}

/** Short stable key for a set of ids; the same set in any order gives the same key. */
function idsKey(ids: readonly string[]): string {
  return createHash('sha1')
    .update([...ids].sort().join(','))
    .digest('base64url')
    .slice(0, 16);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Building the set
// ---------------------------------------------------------------------------

async function build(version: number): Promise<QuerySuggestionSnapshot> {
  const started = Date.now();
  const stats: QuerySuggestionStats = {
    verified: 0,
    rejected: { empty: 0, relaxed: 0, typo: 0, 'no-narrowing': 0, incoherent: 0, misparsed: 0 },
    kept: 0,
    logged: 0,
  };

  const catalog = await searchCatalog();

  // One read of the whole live catalog. Price bounds, scores and brand checks
  // are all computed from this rather than asked of the database per phrase.
  const live = await prisma.product.findMany({
    where: LIVE_PRODUCT_WHERE,
    select: {
      id: true,
      title: true,
      soldCount: true,
      categoryId: true,
      brand: true,
      variants: { select: { pricePaise: true } },
    },
  });
  const liveCount = live.length;
  const product = new Map(
    live.map((p) => [
      p.id,
      {
        title: p.title.toLowerCase(),
        sold: p.soldCount,
        categoryId: p.categoryId,
        brand: p.brand?.toLowerCase() ?? null,
        // A price bound admits a product when any variant is under it, which is
        // the same as its cheapest variant being under it.
        minPrice: p.variants.length ? Math.min(...p.variants.map((v) => v.pricePaise)) : null,
      },
    ]),
  );
  const unitsSold = (ids: readonly string[]) =>
    ids.reduce((sum, id) => sum + (product.get(id)?.sold ?? 0), 0);

  /**
   * How a topic word has to appear in a title to count as naming it.
   *
   * A synonym-map word may appear as any member of its family, as a prefix:
   * "phone" is written "Smartphone" in every title here, and the map is curated,
   * so that is trusted. A word cut from a category name has to appear as itself,
   * whole. That is what stops "kid" (from "Toys & Kids") turning into "cheapest
   * kid", and it picks the form titles actually use — "bag", not "bags".
   */
  function formsOf(word: string): RegExp[] {
    const entry = SEARCH_SYNONYMS.find((e) => e.canonical === word || e.aliases.includes(word));
    if (!entry) return [new RegExp('\\b' + escapeRegex(word) + '\\b', 'i')];
    return [...new Set([entry.canonical, ...entry.aliases])].map(
      (form) => new RegExp('\\b' + escapeRegex(form), 'i'),
    );
  }

  /** How many of these products are titled with this exact word. */
  function titleUses(ids: readonly string[], word: string): number {
    const re = new RegExp('\\b' + escapeRegex(word) + '\\b', 'i');
    return ids.filter((id) => re.test(product.get(id)?.title ?? '')).length;
  }

  /** Whether most of these products are titled as the thing the phrase names. */
  function namesTopic(ids: readonly string[], forms: readonly RegExp[]): boolean {
    const titled = ids.filter((id) => {
      const title = product.get(id)?.title ?? '';
      return forms.some((re) => re.test(title));
    });
    return titled.length / ids.length >= MIN_TITLE_COHERENCE;
  }

  // The same text is never searched twice in one build.
  const checked = new Map<string, Verification>();
  async function check(text: string): Promise<Verification> {
    const known = checked.get(text);
    if (known) return known;
    stats.verified += 1;
    const outcome = await verifyPhrase(text, liveCount);
    if (!outcome.ok) stats.rejected[outcome.reason] += 1;
    checked.set(text, outcome);
    return outcome;
  }
  function reject(reason: RejectReason): void {
    stats.rejected[reason] += 1;
  }

  const phrases = new Map<string, SuggestedPhrase>();
  function keep(
    text: string,
    found: { ids: string[]; parsed: ParsedSearchQuery },
    topicKey: string,
    word: string,
  ) {
    phrases.set(text, {
      text,
      source: 'catalog',
      total: found.ids.length,
      score: unitsSold(found.ids),
      wording: titleUses(found.ids, word),
      topicKey,
      // The same products in a different order is a different page, so the sort
      // is part of what makes two phrases equivalent.
      resultKey: `${found.parsed.sort ?? '-'}:${idsKey(found.ids)}`,
    });
  }

  // -- 1. Topic words -------------------------------------------------------
  // Words from the synonym map and from category names. Each is searched on its
  // own first; only the ones that narrow the catalog become topics.

  const categories = await prisma.category.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  });
  // Same-named categories are one topic: this catalog has two "Smartphones".
  const categoryIdsByName = new Map<string, Set<string>>();
  for (const category of categories) {
    const key = category.name.toLowerCase().trim();
    const ids = categoryIdsByName.get(key) ?? new Set<string>();
    for (const id of await descendantIds(category.id)) ids.add(id);
    categoryIdsByName.set(key, ids);
  }

  // Synonym words first: the map is curated, so they skip the category check.
  // Every word still has to pass the title check below.
  const candidates = new Map<string, Set<string> | null>();
  for (const entry of SEARCH_SYNONYMS) {
    for (const word of [entry.canonical, ...entry.aliases]) {
      if (!candidates.has(word)) candidates.set(word, null);
    }
  }
  for (const [name, ids] of categoryIdsByName) {
    for (const word of categoryWords(name)) {
      if (!candidates.has(word)) candidates.set(word, ids);
    }
  }

  interface Topic {
    word: string;
    ids: string[];
    key: string;
    forms: RegExp[];
  }
  const topics: Topic[] = [];
  for (const [word, categoryIds] of candidates) {
    if (/\d/.test(word) || word.length < 2) continue;
    const found = await check(word);
    if (!found.ok) continue;
    if (categoryIds) {
      const inside = found.ids.filter((id) => categoryIds.has(product.get(id)?.categoryId ?? ''));
      if (inside.length / found.ids.length < MIN_CATEGORY_COHERENCE) {
        reject('incoherent');
        continue;
      }
    }
    const forms = formsOf(word);
    if (!namesTopic(found.ids, forms)) {
      reject('incoherent');
      continue;
    }
    const key = idsKey(found.ids);
    topics.push({ word, ids: found.ids, key, forms });
    keep(word, found, key, word);
  }

  // -- 2. Intent, and price bounds from the topic's own prices ---------------

  // A narrower phrase is held to the same title check as its topic: a price
  // bound or a brand can cut a topic down to exactly its description matches.
  function keepIfAbout(text: string, found: { ids: string[]; parsed: ParsedSearchQuery }, topic: Topic) {
    if (!namesTopic(found.ids, topic.forms)) {
      reject('incoherent');
      return;
    }
    keep(text, found, topic.key, topic.word);
  }

  for (const topic of topics) {
    for (const intent of SUGGESTION_INTENT_WORDS) {
      const text = `${intent} ${topic.word}`;
      const found = await check(text);
      if (!found.ok) continue;
      if (!found.parsed.sort) {
        reject('misparsed');
        continue;
      }
      keepIfAbout(text, found, topic);
    }

    const prices = topic.ids
      .map((id) => product.get(id)?.minPrice)
      .filter((price): price is number => price != null);
    for (const bound of priceBucketsPaise(prices)) {
      const amount = formatRupeesForQuery(bound / 100);
      for (const text of [`${topic.word} under ${amount}`, `best ${topic.word} under ${amount}`]) {
        const found = await check(text);
        if (!found.ok) continue;
        // The wording has to read back as the bound it was built from.
        if (found.parsed.filters.maxPricePaise !== bound) {
          reject('misparsed');
          continue;
        }
        keepIfAbout(text, found, topic);
      }
    }
  }

  // -- 3. Brand + topic ------------------------------------------------------
  // One wording per topic — the one its titles use most — and only where the
  // brand actually sells something in it.

  const preferred = new Map<string, { topic: Topic; uses: number }>();
  for (const topic of topics) {
    const uses = titleUses(topic.ids, topic.word);
    const current = preferred.get(topic.key);
    if (
      !current ||
      uses > current.uses ||
      (uses === current.uses && topic.word.length < current.topic.word.length)
    ) {
      preferred.set(topic.key, { topic, uses });
    }
  }
  for (const brand of catalog.brands) {
    const lower = brand.toLowerCase();
    for (const { topic } of preferred.values()) {
      if (!topic.ids.some((id) => product.get(id)?.brand === lower)) continue;
      const text = `${lower} ${topic.word}`;
      const found = await check(text);
      if (found.ok) keepIfAbout(text, found, topic);
    }
  }

  // -- 4. Logged searches ----------------------------------------------------
  // Only ones that found something as typed, searched often enough, and that
  // still pass verification against today's catalog.

  const groups = await prisma.searchQuery.groupBy({
    by: ['normalized'],
    where: { resultCount: { gt: 0 }, relaxed: false, strategy: { in: ['fts', 'filters-only'] } },
    _count: { _all: true },
  });
  for (const group of groups) {
    if (group._count._all < MIN_LOGGED_SEARCHES) continue;
    const text = group.normalized;
    const found = await check(text);
    if (!found.ok) continue;
    phrases.set(text, {
      text,
      source: 'logged',
      total: found.ids.length,
      score: group._count._all,
      wording: 0,
      topicKey: idsKey(found.ids),
      resultKey: `${found.parsed.sort ?? '-'}:${idsKey(found.ids)}`,
    });
  }

  const ordered = [...phrases.values()].sort(
    (a, b) =>
      (a.source === b.source ? 0 : a.source === 'logged' ? -1 : 1) ||
      b.score - a.score ||
      b.wording - a.wording ||
      a.text.length - b.text.length ||
      a.text.localeCompare(b.text),
  );
  stats.kept = ordered.length;
  stats.logged = ordered.filter((p) => p.source === 'logged').length;

  return {
    version,
    builtAt: new Date(),
    durationMs: Date.now() - started,
    phrases: ordered,
    stats,
  };
}

// ---------------------------------------------------------------------------
// The live set
// ---------------------------------------------------------------------------

let snapshot: QuerySuggestionSnapshot | null = null;
let inFlight: Promise<QuerySuggestionSnapshot> | null = null;
let nextVersion = 1;

/**
 * Rebuild the phrase set. Concurrent calls share one build, and a failed build
 * leaves the previous set serving.
 */
export function refreshQuerySuggestions(): Promise<QuerySuggestionSnapshot> {
  if (inFlight) return inFlight;
  inFlight = build(nextVersion++)
    .then((built) => {
      snapshot = built;
      return built;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function querySuggestionSnapshot(): QuerySuggestionSnapshot | null {
  return snapshot;
}

/** 0 until the first build lands; part of the suggest cache key. */
export function querySuggestionVersion(): number {
  return snapshot?.version ?? 0;
}

/** Build at boot, then on a timer. Failures are logged and never fatal. */
export function startQuerySuggestionRefresh(): void {
  const run = () => {
    refreshQuerySuggestions()
      .then((built) => {
        console.log(
          `[clowe-api] query suggestions: ${built.stats.kept} phrases ` +
            `(${built.stats.logged} logged) from ${built.stats.verified} checked in ${built.durationMs}ms`,
        );
      })
      .catch((err) => console.error('[clowe-api] query suggestion build failed:', err));
  };
  run();
  const timer = setInterval(run, REFRESH_MS);
  timer.unref();
}

// ---------------------------------------------------------------------------
// Lookup — the only part that runs per keystroke
// ---------------------------------------------------------------------------

/**
 * Phrases that complete what was typed.
 *
 * A prefix scan over the prebuilt list, then three passes so the list is useful
 * rather than repetitive:
 *
 *   1. One phrase per topic, and — while the shopper is still on the first
 *      word — no opening word taking more than half the list. "b" should offer
 *      "bag" and "bluetooth speaker" as well as "best …".
 *   2. One phrase per topic, any opening word.
 *   3. Narrower phrases on topics already shown.
 *
 * No pass ever offers two phrases that would open the same page, or one that
 * opens the page the typed text already does.
 */
export function suggestQueries(typed: string, limit = QUERY_SUGGESTION_LIMIT): QuerySuggestion[] {
  if (!snapshot) return [];
  const prefix = normalizeSuggestInput(typed);
  const finished = prefix.trim();
  if (!finished) return [];

  const matches = snapshot.phrases.filter((p) => p.text.startsWith(prefix));

  const seenResults = new Set<string>();
  const exact = matches.find((p) => p.text === finished);
  if (exact) seenResults.add(exact.resultKey);

  const picked = new Set<SuggestedPhrase>();
  const seenTopics = new Set<string>();
  const openings = new Map<string, number>();
  const openingCap = prefix.includes(' ') ? Infinity : Math.ceil(limit / 2);
  const opening = (phrase: SuggestedPhrase) => phrase.text.split(' ')[0] ?? '';

  const usable = (phrase: SuggestedPhrase) =>
    phrase !== exact && !picked.has(phrase) && !seenResults.has(phrase.resultKey);
  const take = (phrase: SuggestedPhrase) => {
    picked.add(phrase);
    seenTopics.add(phrase.topicKey);
    seenResults.add(phrase.resultKey);
    openings.set(opening(phrase), (openings.get(opening(phrase)) ?? 0) + 1);
  };

  for (const phrase of matches) {
    if (picked.size >= limit) break;
    if (!usable(phrase) || seenTopics.has(phrase.topicKey)) continue;
    if ((openings.get(opening(phrase)) ?? 0) >= openingCap) continue;
    take(phrase);
  }
  for (const phrase of matches) {
    if (picked.size >= limit) break;
    if (usable(phrase) && !seenTopics.has(phrase.topicKey)) take(phrase);
  }
  for (const phrase of matches) {
    if (picked.size >= limit) break;
    if (usable(phrase)) take(phrase);
  }

  // Back into priority order, so logged searches always lead.
  return matches
    .filter((phrase) => picked.has(phrase))
    .map(({ text, source }) => ({ text, source }));
}
