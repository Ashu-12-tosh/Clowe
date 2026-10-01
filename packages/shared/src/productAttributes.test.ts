import { describe, expect, it } from 'vitest';
import {
  attributeKeyFromLabel,
  canonicalAttributes,
  missingRequiredAttributes,
  normaliseAttributes,
  productAttributeInputSchema,
} from './productAttributes';
import type { AttributeDef } from './categoryRules';

const FASHION: AttributeDef[] = [
  { key: 'fabric', label: 'Fabric', type: 'text', required: true },
  { key: 'country_of_origin', label: 'Country of origin', type: 'text', required: true },
  { key: 'wash_care', label: 'Wash care', type: 'text' },
];

describe('attributeKeyFromLabel', () => {
  it('derives a snake_case key from the label', () => {
    expect(attributeKeyFromLabel('Power output')).toBe('power_output');
    expect(attributeKeyFromLabel('  Power / battery ')).toBe('power_battery');
    expect(attributeKeyFromLabel('Screen size (inches)')).toBe('screen_size_inches');
  });

  it('always yields a valid key, even from a label with no letters to start it', () => {
    expect(attributeKeyFromLabel('5G support')).toBe('x_5g_support');
    expect(attributeKeyFromLabel('???')).toBe('detail');
    expect(attributeKeyFromLabel('a'.repeat(60))).toHaveLength(32);
  });
});

describe('canonicalAttributes', () => {
  it('gives a row that matches a rule field by label the rule key and label', () => {
    expect(canonicalAttributes([{ label: 'fabric', value: 'Cotton' }], FASHION)).toEqual([
      { key: 'fabric', label: 'Fabric', value: 'Cotton' },
    ]);
  });

  it('matches a row that already carries a key on the key, not the label', () => {
    expect(
      canonicalAttributes([{ key: 'wash_care', label: 'Care', value: 'Hand wash' }], FASHION),
    ).toEqual([{ key: 'wash_care', label: 'Wash care', value: 'Hand wash' }]);
  });

  it('derives the key of a custom row from its label', () => {
    expect(canonicalAttributes([{ label: 'Power output', value: '250 W' }], FASHION)).toEqual([
      { key: 'power_output', label: 'Power output', value: '250 W' },
    ]);
  });

  it('accepts the legacy { name, value } shape', () => {
    expect(canonicalAttributes([{ name: 'Country of origin', value: 'India' }], FASHION)).toEqual([
      { key: 'country_of_origin', label: 'Country of origin', value: 'India' },
    ]);
  });

  it('keeps the last value when two rows share a key, in the first row’s position', () => {
    expect(
      canonicalAttributes(
        [
          { label: 'Fabric', value: 'Cotton' },
          { label: 'Wash care', value: 'Machine wash' },
          { label: 'fabric', value: 'Linen' },
        ],
        FASHION,
      ),
    ).toEqual([
      { key: 'fabric', label: 'Fabric', value: 'Linen' },
      { key: 'wash_care', label: 'Wash care', value: 'Machine wash' },
    ]);
  });

  it('drops rows with nothing to show', () => {
    expect(canonicalAttributes([{ label: '  ', value: 'x' }, { label: 'Fit', value: ' ' }])).toEqual([]);
  });
});

describe('normaliseAttributes', () => {
  it('reads both stored shapes as canonical rows', () => {
    expect(
      normaliseAttributes(
        [
          { name: 'Fabric', value: 'Cotton' },
          { key: 'country_of_origin', label: 'Country of origin', value: 'India' },
        ],
        FASHION,
      ),
    ).toEqual([
      { key: 'fabric', label: 'Fabric', value: 'Cotton' },
      { key: 'country_of_origin', label: 'Country of origin', value: 'India' },
    ]);
  });

  it('ignores junk in the column', () => {
    expect(normaliseAttributes(null)).toEqual([]);
    expect(normaliseAttributes('nope')).toEqual([]);
    expect(normaliseAttributes([null, 3, { value: 'x' }, { name: 'Fit' }, { name: 'Fit', value: 1 }])).toEqual([]);
  });

  it('is a fixed point: normalising canonical rows changes nothing', () => {
    const once = normaliseAttributes([{ name: 'Power output', value: '250 W' }]);
    expect(normaliseAttributes(once)).toEqual(once);
  });
});

describe('missingRequiredAttributes', () => {
  it('names the required fields that have no value, by label', () => {
    expect(missingRequiredAttributes([{ key: 'fabric', label: 'Fabric', value: 'Cotton' }], FASHION)).toEqual([
      'Country of origin',
    ]);
  });

  it('is satisfied by a key, however the label was spelt', () => {
    const rows = canonicalAttributes(
      [
        { name: 'FABRIC', value: 'Cotton' },
        { name: 'country of origin', value: 'India' },
      ],
      FASHION,
    );
    expect(missingRequiredAttributes(rows, FASHION)).toEqual([]);
  });
});

describe('productAttributeInputSchema', () => {
  it('needs a label or a name', () => {
    expect(productAttributeInputSchema.safeParse({ value: 'x' }).success).toBe(false);
    expect(productAttributeInputSchema.safeParse({ name: 'Fit', value: 'Slim' }).success).toBe(true);
    expect(productAttributeInputSchema.safeParse({ key: 'fit', label: 'Fit', value: 'Slim' }).success).toBe(true);
  });

  it('rejects a key a rule could never declare', () => {
    expect(productAttributeInputSchema.safeParse({ key: 'Fit Type', label: 'Fit', value: 'Slim' }).success).toBe(false);
  });
});
