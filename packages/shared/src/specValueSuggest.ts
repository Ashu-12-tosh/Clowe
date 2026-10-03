// ---------------------------------------------------------------------------
// Spec values sellers typed off the list.
//
// A facet lists its known values ("Half sleeve", "Solid"); a seller's spec
// sheet can still hold anything typed before the list existed or around it:
// "hlaf", "plan", "Half Sleeves". This proposes the known value each one most
// likely meant, for an admin to approve; nothing here writes.
// ---------------------------------------------------------------------------

/**
 * Words sellers use for a value a facet lists under another name. Applied
 * only when the target is on that facet's list.
 */
export const SPEC_VALUE_ALIASES: Record<string, string> = {
  plain: 'Solid',
  check: 'Checked',
  checks: 'Checked',
  stripe: 'Striped',
  stripes: 'Striped',
  'no sleeve': 'Sleeveless',
  'without sleeve': 'Sleeveless',
};

/** Lower case, punctuation to spaces, and each word's plural "s" dropped. */
function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => (w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w))
    .join(' ');
}

/** Edit distance counting a swap of two neighbours as one edit ("hlaf" → "half"). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** How many edits a word of this length may be off by and still be that word. */
function tolerance(length: number): number {
  return length <= 4 ? 1 : length <= 8 ? 2 : 3;
}

export interface SpecValueSuggestion {
  /** The known value to use, or null when nothing is close, or two are equally close. */
  suggestion: string | null;
  /** Why: written differently, a typo, a word for it, or a typo of its first word. */
  reason: 'spelling' | 'typo' | 'alias' | 'word' | null;
  /** Equally close known values, when it could not choose. */
  alternatives: string[];
}

/** The nearest candidates by distance, if within tolerance; several when tied. */
function nearest(needle: string, candidates: { form: string; value: string }[]): string[] {
  let best = Infinity;
  let found: string[] = [];
  for (const c of candidates) {
    const d = editDistance(needle, c.form);
    if (d > tolerance(Math.max(needle.length, c.form.length))) continue;
    if (d < best) {
      best = d;
      found = [c.value];
    } else if (d === best && !found.includes(c.value)) {
      found.push(c.value);
    }
  }
  return found;
}

/** The known value an off-list spec value most likely meant. */
export function suggestSpecValue(value: string, known: readonly string[]): SpecValueSuggestion {
  const n = norm(value);
  const none: SpecValueSuggestion = { suggestion: null, reason: null, alternatives: [] };
  if (!n || known.length === 0) return none;
  const pick = (found: string[], reason: SpecValueSuggestion['reason']): SpecValueSuggestion | null => {
    if (found.length === 1) return { suggestion: found[0], reason, alternatives: [] };
    if (found.length > 1) return { suggestion: null, reason: null, alternatives: found };
    return null;
  };

  // 1. The same value written differently: case, punctuation, a plural.
  const same = known.filter((k) => norm(k) === n);
  if (same.length) return pick(same, 'spelling')!;

  // 2. A word for a listed value, possibly misspelt: "plan" → "plain" → Solid.
  const knownByLower = new Map(known.map((k) => [k.toLowerCase(), k]));
  const aliases = Object.entries(SPEC_VALUE_ALIASES)
    .filter(([, target]) => knownByLower.has(target.toLowerCase()))
    .map(([alias, target]) => ({ form: norm(alias), value: knownByLower.get(target.toLowerCase())! }));
  const viaAlias = pick(nearest(n, aliases), 'alias');
  if (viaAlias) return viaAlias;

  // 3. A typo of a whole listed value: "sleevless" → Sleeveless.
  const typo = pick(nearest(n, known.map((k) => ({ form: norm(k), value: k }))), 'typo');
  if (typo) return typo;

  // 4. One word that is a typo of a listed value's first word: "hlaf" → Half sleeve.
  if (!n.includes(' ')) {
    const firsts = known
      .filter((k) => norm(k).includes(' '))
      .map((k) => ({ form: norm(k).split(' ')[0], value: k }));
    const word = pick(nearest(n, firsts), 'word');
    if (word) return word;
  }
  return none;
}
