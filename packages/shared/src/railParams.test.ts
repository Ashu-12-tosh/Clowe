import { describe, expect, it } from 'vitest';
import { railFilterCount, selectedValues, withChipRemoved, withRailCleared, withValueToggled } from './railParams';

const q = (s: string) => new URLSearchParams(s);

describe('the filter rail in the URL', () => {
  it('adds and removes facet values one parameter each, keeping the search and resetting the page', () => {
    const on = withValueToggled(q('q=shirt&page=3&f[size]=M'), { param: 'f[size]', multi: true }, 'L');
    expect(on.toString()).toBe('q=shirt&f%5Bsize%5D=M&f%5Bsize%5D=L');
    const off = withValueToggled(on, { param: 'f[size]', multi: true }, 'm');
    expect(off.getAll('f[size]')).toEqual(['L']);
  });

  it('keeps a value that holds a comma whole', () => {
    const next = withValueToggled(q(''), { param: 'f[fabric]', multi: true }, 'Nylon shell, polyester fill');
    expect(selectedValues(next, 'f[fabric]')).toEqual(['Nylon shell, polyester fill']);
  });

  it('moves an old link onto f[…] when the facet is edited, a colour as its family', () => {
    const old = q('colors=Navy,Black&opt[ram]=16GB');
    expect(selectedValues(old, 'f[color]')).toEqual(['Blue', 'Black']);
    const next = withValueToggled(old, { param: 'f[color]', multi: true }, 'Blue');
    expect(next.has('colors')).toBe(false);
    expect(next.getAll('f[color]')).toEqual(['Black']);
    expect(next.get('opt[ram]')).toBe('16GB');
  });

  it('toggles brands as a list and single-valued filters as one value', () => {
    expect(withValueToggled(q('brands=Alpha'), { param: 'brands', multi: true }, 'Beta').get('brands')).toBe('Alpha,Beta');
    expect(withValueToggled(q('rating=3'), { param: 'rating', multi: false }, '4').get('rating')).toBe('4');
    expect(withValueToggled(q('rating=4'), { param: 'rating', multi: false }, '4').has('rating')).toBe(false);
  });

  it('removes a chip, the price chip taking both ends', () => {
    expect(withChipRemoved(q('minPrice=500&maxPrice=900&brands=A'), { param: 'price', value: '' }).toString()).toBe('brands=A');
    expect(withChipRemoved(q('f[ram]=8GB&f[ram]=16GB'), { param: 'f[ram]', value: '16GB' }).getAll('f[ram]')).toEqual(['8GB']);
    expect(withChipRemoved(q('inStock=1'), { param: 'inStock', value: '1' }).toString()).toBe('');
  });

  it('clears every filter but leaves the words, the category and the sort', () => {
    const cleared = withRailCleared(q('q=tv&category=electronics&sort=price_asc&f[x]=1&opt[y]=2&brands=A&minPrice=1&inStock=1&page=2'));
    expect(cleared.toString()).toBe('q=tv&category=electronics&sort=price_asc');
  });

  it('counts applied filters, a price range as one', () => {
    expect(railFilterCount(q('f[size]=M&f[size]=L&brands=A,B&minPrice=1&maxPrice=9&rating=4&q=x'))).toBe(6);
  });
});
