import { describe, expect, it } from 'vitest';
import { resolveCategoryRules, type CategoryRuleFields } from './categoryRules';

const node = (returnable: boolean | null): CategoryRuleFields => ({
  variantAxes: null,
  attributeSchema: null,
  tryOnEligible: null,
  sizeGuide: null,
  taxRule: null,
  defaultTaxRatePercent: null,
  hsnCode: null,
  returnWindowDays: null,
  returnable,
});

describe('Returnable, along the category tree (nearest first)', () => {
  it('is yes when nothing sets it', () => {
    expect(resolveCategoryRules([node(null), node(null)]).returnable).toBe(true);
  });
  it('a parent set off covers its subcategories', () => {
    expect(resolveCategoryRules([node(null), node(false)]).returnable).toBe(false);
  });
  it('a subcategory overrides its parent, either way', () => {
    expect(resolveCategoryRules([node(true), node(false)]).returnable).toBe(true);
    expect(resolveCategoryRules([node(false), node(true)]).returnable).toBe(false);
  });
});
