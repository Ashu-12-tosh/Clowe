import type { TryOnGarmentCategory } from './TryOnProvider';

/**
 * Map a product's category to the garment category the try-on model expects.
 *
 * FASHN classifies the garment itself when given 'auto', and that classifier
 * is good. So this only overrides it where our own category tree is
 * unambiguous — a wrong hint is worse than no hint, because it forces the
 * model to warp a dress onto a leg region.
 *
 * Matching is on whole words so "Tops" does not match "Laptops" and "Suit"
 * does not match "Swimsuit" by accident.
 */
const BOTTOMS = [
  'bottom',
  'bottoms',
  'jean',
  'jeans',
  'trouser',
  'trousers',
  'pant',
  'pants',
  'chino',
  'chinos',
  'short',
  'shorts',
  'skirt',
  'skirts',
  'legging',
  'leggings',
  'jogger',
  'joggers',
  'trackpant',
  'trackpants',
  'pyjama',
  'pyjamas',
  'palazzo',
  'palazzos',
  'dhoti',
  'lehenga',
];

const ONE_PIECES = [
  'dress',
  'dresses',
  'gown',
  'gowns',
  'jumpsuit',
  'jumpsuits',
  'dungaree',
  'dungarees',
  'romper',
  'rompers',
  'saree',
  'sarees',
  'sari',
  'kaftan',
  'kaftans',
  'abaya',
  'overall',
  'overalls',
  'bodysuit',
  'bodysuits',
  'swimsuit',
  'swimsuits',
];

const TOPS = [
  'top',
  'tops',
  'shirt',
  'shirts',
  'tshirt',
  'tshirts',
  'tee',
  'tees',
  'blouse',
  'blouses',
  'jacket',
  'jackets',
  'coat',
  'coats',
  'overcoat',
  'overcoats',
  'sweater',
  'sweaters',
  'sweatshirt',
  'sweatshirts',
  'hoodie',
  'hoodies',
  'blazer',
  'blazers',
  'kurta',
  'kurti',
  'kurtis',
  'cardigan',
  'cardigans',
  'jumper',
  'jumpers',
  'pullover',
  'pullovers',
  'vest',
  'vests',
  'kurtas',
];

/** Lowercased word list, with "t-shirt" also yielding "tshirt". */
function wordsOf(text: string): Set<string> {
  const normalised = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const words = normalised.split(' ').filter(Boolean);
  const set = new Set(words);
  // "t shirt" -> "tshirt", "sweat shirt" -> "sweatshirt"
  for (let i = 0; i < words.length - 1; i++) set.add(words[i] + words[i + 1]);
  return set;
}

/**
 * Pick a garment category from any text that describes the product — its
 * category name first, then its title. Returns 'auto' when nothing matches,
 * and when a text matches more than one group (so the model decides).
 */
export function garmentCategoryFor(...texts: (string | null | undefined)[]): TryOnGarmentCategory {
  for (const text of texts) {
    if (!text) continue;
    const words = wordsOf(text);
    const hits: TryOnGarmentCategory[] = [];
    if (ONE_PIECES.some((w) => words.has(w))) hits.push('one-pieces');
    if (BOTTOMS.some((w) => words.has(w))) hits.push('bottoms');
    if (TOPS.some((w) => words.has(w))) hits.push('tops');
    // Exactly one group matched this text: confident enough to override.
    if (hits.length === 1) return hits[0];
    // Ambiguous ("Shirts & Trousers"): stop here rather than fall through to
    // a less specific text that might guess differently.
    if (hits.length > 1) return 'auto';
  }
  return 'auto';
}
