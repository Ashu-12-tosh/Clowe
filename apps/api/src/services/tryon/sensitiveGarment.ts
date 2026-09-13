/**
 * Products that must never go through AI try-on, whatever their category says.
 *
 * Try-on paints a garment onto a photo of a real person's body. For innerwear,
 * lingerie, swimwear and sleepwear that produces a near-undressed image of a
 * customer from a photo they uploaded for shopping — not something to generate
 * on anyone's behalf, and not something to store in try-on history.
 *
 * The category tree already turns try-on off for the Innerwear department.
 * This is the second layer: a seller can list a bikini under "Women", and
 * new departments get added without anyone revisiting the try-on rules. It is
 * checked on the product's own title too, so the listing itself has to look
 * innocuous for it to slip through both.
 */

/** Matched as whole words, so "bra" never fires on "bracelet" or "brace". */
const SENSITIVE_WORDS = [
  // Innerwear
  'innerwear',
  'underwear',
  'undergarment',
  'undergarments',
  'lingerie',
  'bra',
  'bras',
  'bralette',
  'bralettes',
  'brassiere',
  'brief',
  'briefs',
  'boxer',
  'boxers',
  // Plural only: underwear is sold as "trunks", a car's is a singular "trunk".
  'trunks',
  'panty',
  'panties',
  'thong',
  'thongs',
  'jockstrap',
  'camisole',
  'camisoles',
  'chemise',
  'corset',
  'corsets',
  'bustier',
  'shapewear',
  'petticoat',
  'undershirt',
  'undershirts',
  // Worn directly against the skin
  'thermal',
  'thermals',
  'baselayer',
  // Sleepwear
  'nightwear',
  'nighty',
  'nightie',
  'nightdress',
  'nightgown',
  'negligee',
  'sleepwear',
  // Swimwear
  'swimwear',
  'swimsuit',
  'swimsuits',
  'swimming',
  'bikini',
  'bikinis',
  'monokini',
  'swimshorts',
  'swimtrunks',
  'beachwear',
];

const SENSITIVE_SET = new Set(SENSITIVE_WORDS);

/**
 * Compounds that contain a sensitive word but are not garments. When one is
 * present the word that formed it is ignored, so "Leather Brief Case" reads as
 * a briefcase rather than as underwear.
 */
const SAFE_COMPOUNDS = new Map<string, string[]>([['briefcase', ['brief', 'briefs']]]);

/**
 * Words in a text, plus each adjacent pair joined — so "inner wear",
 * "night wear", "swim suit" and "base layer" are caught as well as the
 * single-word spellings.
 */
function wordsOf(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  const set = new Set(words);
  for (let i = 0; i < words.length - 1; i++) set.add(words[i] + words[i + 1]);
  return set;
}

/**
 * True when any of the given texts (category name, product title, …) names a
 * garment that must not be tried on. Callers pass everything they know; one
 * match anywhere is enough.
 */
export function isSensitiveForTryOn(...texts: (string | null | undefined)[]): boolean {
  for (const text of texts) {
    if (!text) continue;
    const words = wordsOf(text);
    const excused = new Set<string>();
    for (const [compound, covers] of SAFE_COMPOUNDS) {
      if (words.has(compound)) for (const word of covers) excused.add(word);
    }
    for (const word of words) {
      if (SENSITIVE_SET.has(word) && !excused.has(word)) return true;
    }
  }
  return false;
}
