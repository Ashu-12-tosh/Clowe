import { describe, expect, it } from 'vitest';
import { COLOR_FAMILIES, colorFamilyOf } from './colorFamily';

/** Every distinct colour the demo catalog's variants carried when this was written. */
const CATALOG_COLOURS = [
  'Black', 'White', 'Silver', 'Blue', 'Navy', 'Grey', 'Olive', 'Beige', 'Graphite', 'Maroon',
  'Pink', 'Rose Gold', 'Multicolour', 'Gold', 'Red', 'Tan', 'Brown', 'Mustard', 'Midnight',
  'Ivory', 'Cream', 'Emerald', 'Charcoal', 'Purple', 'Powder Blue', 'Yellow', 'Green',
  'Sage Green', 'Sage', 'Ocean Blue', 'Titanium', 'Light Blue', 'Starlight', 'Tortoise', 'Teal',
  'Dark Blue', 'Lavender', 'Space Grey', 'Peach', 'Sky Blue', 'Steel', 'Blush', 'Wine',
  'Champagne', 'Natural', 'Steel Grey', 'Walnut', 'Oak', 'Black Glass',
];

describe('colorFamilyOf', () => {
  it('places shaded names by their hue word', () => {
    expect(colorFamilyOf('Sage Green')).toBe('Green');
    expect(colorFamilyOf('Space Grey')).toBe('Grey');
    expect(colorFamilyOf('Powder Blue')).toBe('Blue');
    expect(colorFamilyOf('Dark Blue')).toBe('Blue');
    expect(colorFamilyOf('Steel Grey')).toBe('Grey');
  });

  it('treats metals as Metallic, including Rose Gold', () => {
    expect(colorFamilyOf('Rose Gold')).toBe('Metallic');
    expect(colorFamilyOf('Silver')).toBe('Metallic');
    expect(colorFamilyOf('Titanium')).toBe('Metallic');
  });

  it('is indifferent to case, spacing and punctuation', () => {
    expect(colorFamilyOf('  sky-blue ')).toBe('Blue');
    expect(colorFamilyOf('OFF WHITE')).toBe('White');
    expect(colorFamilyOf('Multi-Colour')).toBe('Multicolour');
  });

  it('returns null for a colour it does not know, rather than guessing', () => {
    expect(colorFamilyOf('Zebra')).toBeNull();
    expect(colorFamilyOf('')).toBeNull();
    expect(colorFamilyOf(null)).toBeNull();
    expect(colorFamilyOf('   ')).toBeNull();
  });

  it('covers every colour the catalog uses', () => {
    const unmatched = CATALOG_COLOURS.filter((c) => colorFamilyOf(c) === null);
    expect(unmatched).toEqual([]);
  });

  it('only ever answers with a declared family', () => {
    for (const c of CATALOG_COLOURS) {
      expect(COLOR_FAMILIES).toContain(colorFamilyOf(c));
    }
  });
});
