// ---------------------------------------------------------------------------
// Colour families
//
// Sellers name colours freely — Powder Blue, Sky Blue, Ocean Blue, Navy — and
// a shopper filtering for "blue" wants all of them. A family is the one of
// fourteen broad names a value belongs to; the API stores it beside the
// colour on every variant (optionValues.color_family) so a facet can group
// on it without parsing free text at query time.
// ---------------------------------------------------------------------------

export const COLOR_FAMILIES = [
  'Black',
  'White',
  'Grey',
  'Blue',
  'Green',
  'Red',
  'Pink',
  'Purple',
  'Yellow',
  'Orange',
  'Brown',
  'Beige',
  'Metallic',
  'Multicolour',
] as const;
export type ColorFamily = (typeof COLOR_FAMILIES)[number];

/**
 * Every colour word the catalog uses or a seller is likely to type, by
 * family. A value is looked up whole first, then word by word from the end,
 * so "Sage Green" and "Space Grey" resolve on their last word while
 * "Rose Gold" lands on Metallic rather than Pink.
 */
const WORDS_BY_FAMILY: Record<ColorFamily, string[]> = {
  Black: ['black', 'jet', 'onyx', 'ebony', 'midnight', 'obsidian'],
  White: ['white', 'ivory', 'snow', 'starlight', 'pearl', 'off white', 'offwhite'],
  Grey: ['grey', 'gray', 'charcoal', 'graphite', 'slate', 'ash', 'smoke', 'stone', 'heather', 'gunmetal', 'space grey', 'space gray'],
  Blue: ['blue', 'navy', 'sky', 'cobalt', 'indigo', 'denim', 'turquoise', 'aqua', 'cyan', 'azure', 'royal', 'ocean', 'powder', 'sapphire', 'petrol'],
  Green: ['green', 'olive', 'sage', 'emerald', 'teal', 'mint', 'lime', 'forest', 'moss', 'pista', 'bottle', 'sea green', 'jade'],
  Red: ['red', 'maroon', 'wine', 'burgundy', 'crimson', 'scarlet', 'cherry', 'ruby', 'brick'],
  Pink: ['pink', 'blush', 'rose', 'magenta', 'fuchsia', 'salmon', 'onion'],
  Purple: ['purple', 'lavender', 'violet', 'lilac', 'mauve', 'plum', 'grape', 'orchid', 'aubergine'],
  Yellow: ['yellow', 'mustard', 'lemon', 'canary', 'ochre', 'saffron'],
  Orange: ['orange', 'peach', 'coral', 'rust', 'apricot', 'tangerine', 'amber', 'terracotta'],
  Brown: ['brown', 'tan', 'chocolate', 'coffee', 'mocha', 'walnut', 'oak', 'tortoise', 'tortoiseshell', 'camel', 'cognac', 'espresso', 'mahogany', 'chestnut'],
  Beige: ['beige', 'cream', 'sand', 'nude', 'taupe', 'oatmeal', 'ecru', 'khaki', 'champagne', 'natural', 'biscuit'],
  Metallic: ['silver', 'gold', 'golden', 'rose gold', 'bronze', 'copper', 'titanium', 'steel', 'chrome', 'platinum', 'metallic'],
  Multicolour: ['multicolour', 'multicolor', 'multi colour', 'multi color', 'multi', 'printed', 'assorted', 'rainbow'],
};

const FAMILY_BY_WORD = new Map<string, ColorFamily>();
for (const family of COLOR_FAMILIES) {
  for (const word of WORDS_BY_FAMILY[family]) FAMILY_BY_WORD.set(word, family);
}

function normaliseColour(value: string): string {
  return value.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
}

/** The family a colour value belongs to, or null when no word of it is known. */
export function colorFamilyOf(value: string | null | undefined): ColorFamily | null {
  if (!value) return null;
  const phrase = normaliseColour(value);
  if (!phrase) return null;
  const whole = FAMILY_BY_WORD.get(phrase);
  if (whole) return whole;
  // Two-word phrases first ("rose gold", "off white"), then single words,
  // scanning from the end because the last word names the hue and earlier
  // ones shade it ("Space Grey", "Dark Blue").
  const words = phrase.split(' ');
  for (let i = words.length - 1; i >= 0; i -= 1) {
    if (i > 0) {
      const pair = FAMILY_BY_WORD.get(`${words[i - 1]} ${words[i]}`);
      if (pair) return pair;
    }
    const single = FAMILY_BY_WORD.get(words[i]);
    if (single) return single;
  }
  return null;
}
