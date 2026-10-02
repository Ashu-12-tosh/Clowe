import { describe, expect, it } from 'vitest';
import { categoryFacetConfigSchema, facetConfigFromJson, resolveFacets, type CategoryFacetConfig } from './facets';

const config = (c: Partial<CategoryFacetConfig>): CategoryFacetConfig => ({ add: [], hide: [], ...c });

describe('resolveFacets — inherited down the tree, root first', () => {
  const root = { id: 'electronics', config: config({ add: [{ key: 'color', label: 'Colour', kind: 'color' }] }) };

  it('gives a child its parent facets plus its own', () => {
    const laptops = {
      id: 'laptops',
      config: config({ add: [{ key: 'ram', label: 'RAM', kind: 'list' }, { key: 'processor', label: 'Processor', kind: 'list' }] }),
    };
    expect(resolveFacets([root, laptops]).map((f) => [f.key, f.fromCategoryId])).toEqual([
      ['color', 'electronics'],
      ['ram', 'laptops'],
      ['processor', 'laptops'],
    ]);
  });

  it('inherits unchanged when the child stores nothing', () => {
    expect(resolveFacets([root, { id: 'tvs', config: null }]).map((f) => f.key)).toEqual(['color']);
  });

  it('lets a child hide, override in place, and reorder', () => {
    const fashion = {
      id: 'fashion',
      config: config({
        add: [
          { key: 'size', label: 'Size', kind: 'size' },
          { key: 'color', label: 'Colour', kind: 'color' },
          { key: 'fabric', label: 'Fabric', kind: 'list' },
          { key: 'pattern', label: 'Pattern', kind: 'list' },
        ],
      }),
    };
    const footwear = {
      id: 'footwear',
      config: config({
        hide: ['pattern'],
        add: [
          { key: 'fabric', label: 'Material', kind: 'list' },
          { key: 'footwear_type', label: 'Type', kind: 'list' },
        ],
        order: ['footwear_type', 'size'],
      }),
    };
    const resolved = resolveFacets([fashion, footwear]);
    expect(resolved.map((f) => f.key)).toEqual(['footwear_type', 'size', 'color', 'fabric']);
    expect(resolved.find((f) => f.key === 'fabric')).toMatchObject({ label: 'Material', fromCategoryId: 'footwear' });
  });

  it('carries the hide down to grandchildren', () => {
    const child = { id: 'child', config: config({ hide: ['color'] }) };
    const grandchild = { id: 'grandchild', config: config({ add: [{ key: 'kit', label: 'Kit', kind: 'list' }] }) };
    expect(resolveFacets([root, child, grandchild]).map((f) => f.key)).toEqual(['kit']);
  });
});

describe('the stored config', () => {
  it('refuses a common facet key and a key listed twice', () => {
    const r = categoryFacetConfigSchema.safeParse({
      add: [
        { key: 'brand', label: 'Brand' },
        { key: 'ram', label: 'RAM' },
        { key: 'ram', label: 'Memory' },
      ],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.message)).toEqual(['"brand" is on every rail already', '"ram" is listed twice']);
  });

  it('reads malformed JSON as no config, rather than throwing', () => {
    expect(facetConfigFromJson({ add: 'nonsense' })).toBeNull();
    expect(facetConfigFromJson(null)).toBeNull();
    expect(facetConfigFromJson({ add: [{ key: 'ram', label: 'RAM' }] })).toEqual({
      add: [{ key: 'ram', label: 'RAM', kind: 'list' }],
      hide: [],
    });
  });
});
