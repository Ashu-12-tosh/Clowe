import { describe, expect, it } from 'vitest';
import { editDistance, suggestSpecValue } from './specValueSuggest';

const SLEEVE = ['Full sleeve', 'Half sleeve', 'Three-quarter sleeve', 'Short sleeve', 'Sleeveless'];
const PATTERN = ['Solid', 'Printed', 'Striped', 'Checked', 'Floral', 'Textured'];

describe('suggestSpecValue', () => {
  it('reads "hlaf" as Half sleeve and "plan" as Solid', () => {
    expect(suggestSpecValue('hlaf', SLEEVE)).toEqual({ suggestion: 'Half sleeve', reason: 'word', alternatives: [] });
    expect(suggestSpecValue('plan', PATTERN)).toEqual({ suggestion: 'Solid', reason: 'alias', alternatives: [] });
  });

  it('matches a value written differently', () => {
    expect(suggestSpecValue('Half Sleeves', SLEEVE).suggestion).toBe('Half sleeve');
    expect(suggestSpecValue('half-sleeve', SLEEVE).suggestion).toBe('Half sleeve');
    expect(suggestSpecValue('Plain', PATTERN).suggestion).toBe('Solid');
    expect(suggestSpecValue('stripes', PATTERN).suggestion).toBe('Striped');
  });

  it('corrects a typo of a whole value', () => {
    expect(suggestSpecValue('sleevless', SLEEVE)).toMatchObject({ suggestion: 'Sleeveless', reason: 'typo' });
    expect(suggestSpecValue('Prnted', PATTERN)).toMatchObject({ suggestion: 'Printed', reason: 'typo' });
  });

  it('suggests nothing when nothing is close', () => {
    expect(suggestSpecValue('Zari work', PATTERN).suggestion).toBeNull();
    expect(suggestSpecValue('xyz', SLEEVE).suggestion).toBeNull();
  });

  it('will not choose between two equally close values', () => {
    const r = suggestSpecValue('Sxort sleeve', ['Short sleeve', 'Sport sleeve']);
    expect(r.suggestion).toBeNull();
    expect(r.alternatives.sort()).toEqual(['Short sleeve', 'Sport sleeve']);
  });

  it('uses an alias only when its target is on the list', () => {
    expect(suggestSpecValue('plain', ['Printed', 'Floral']).suggestion).toBeNull();
  });
});

describe('editDistance', () => {
  it('counts a swap of neighbours as one edit', () => {
    expect(editDistance('hlaf', 'half')).toBe(1);
    expect(editDistance('plan', 'plain')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});
