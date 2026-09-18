import { describe, expect, it } from 'vitest';
import { normalizeSuggestInput, splitCompletion } from './search';
import { SUGGESTION_INTENT_WORDS, parseSearchQuery } from './searchQuery';

describe('typed text, as query suggestions see it', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeSuggestInput('  Best   Phone')).toBe('best phone');
  });

  it('keeps one trailing space, because it says the last word is finished', () => {
    expect(normalizeSuggestInput('best ')).toBe('best ');
    expect(normalizeSuggestInput('best    ')).toBe('best ');
  });

  it('is empty for nothing typed', () => {
    expect(normalizeSuggestInput('')).toBe('');
    expect(normalizeSuggestInput('   ')).toBe('');
  });
});

describe('splitting a suggestion into what was typed and what is suggested', () => {
  it('puts the typed prefix first and the completion after', () => {
    expect(splitCompletion('best phone under 15k', 'best p')).toEqual({
      typed: 'best p',
      completion: 'hone under 15k',
    });
  });

  it('matches however the prefix was cased or spaced', () => {
    expect(splitCompletion('best phone', 'BEST  P')).toEqual({ typed: 'best p', completion: 'hone' });
  });

  it('keeps a typed trailing space in the plain half', () => {
    expect(splitCompletion('best phone', 'best ')).toEqual({ typed: 'best ', completion: 'phone' });
  });

  it('bolds the whole phrase when it does not start with what was typed', () => {
    expect(splitCompletion('cheapest phone', 'phone')).toEqual({
      typed: '',
      completion: 'cheapest phone',
    });
  });
});

describe('intent words the dropdown builds phrases from', () => {
  // A phrase built from a word the parser does not understand would mean one
  // thing in the dropdown and another on the page it opens.
  const catalog = { brands: [], categories: [] };
  it.each(SUGGESTION_INTENT_WORDS)('"%s" parses to a sort and leaves no stray keywords', (word) => {
    const parsed = parseSearchQuery(`${word} phone`, catalog);
    expect(parsed.sort).not.toBeNull();
    expect(parsed.cleanedKeywords).toBe('smartphone');
  });
});
