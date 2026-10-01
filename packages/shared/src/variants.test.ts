import { describe, expect, it } from 'vitest';
import {
  normalizeOptionValues,
  optionAxisKeys,
  optionValuesFromJson,
  variantOptionFields,
  withDerivedOptions,
} from './variants';

/**
 * color_family is written into optionValues for the filter rail and nowhere
 * else: it must never become an axis, change a variant's identity or show
 * up on a read.
 */
describe('derived option keys', () => {
  it('are added on write when the colour is known', () => {
    expect(withDerivedOptions({ color: 'Powder Blue', size: 'M' })).toEqual({
      color: 'Powder Blue',
      size: 'M',
      color_family: 'Blue',
    });
  });

  it('are left out when the colour is unknown or absent', () => {
    expect(withDerivedOptions({ color: 'Zebra' })).toEqual({ color: 'Zebra' });
    expect(withDerivedOptions({ size: 'M' })).toEqual({ size: 'M' });
  });

  it('are dropped on read, so the storefront and the form never see them as an axis', () => {
    expect(normalizeOptionValues({ color: 'Navy', color_family: 'Blue' })).toEqual({ color: 'Navy' });
    expect(optionValuesFromJson({ size: 'L', color_family: 'Blue' })).toEqual({ size: 'L' });
    expect(optionAxisKeys({ color: 'Navy', size: 'L', color_family: 'Blue' })).toEqual(['color', 'size']);
  });

  it('sit in the stored map but not in the options key, label or caches', () => {
    const fields = variantOptionFields({ color: 'Sage Green', size: 'S' });
    expect(fields.optionValues).toEqual({ color: 'Sage Green', size: 'S', color_family: 'Green' });
    expect(fields.optionsKey).toBe('color=Sage Green|size=S');
    expect(fields.label).toBe('Sage Green · S');
    expect(fields.color).toBe('Sage Green');
  });

  it('are recomputed from the colour, not trusted from the client', () => {
    const fields = variantOptionFields({ color: 'Maroon', color_family: 'Blue' });
    expect(fields.optionValues.color_family).toBe('Red');
  });
});
