import { describe, expect, it } from 'vitest';
import { assetIdOf, assetRef, assetRefSchema, isAssetRef } from './assets';

describe('asset references', () => {
  const id = 'cmtikqsgn000x20iiuvjc4pkn';

  it('round-trips an id', () => {
    expect(assetRef(id)).toBe(`asset:${id}`);
    expect(assetIdOf(assetRef(id))).toBe(id);
    expect(isAssetRef(assetRef(id))).toBe(true);
  });

  it('is never a URL, a path, or anything with extra characters', () => {
    for (const value of [
      `https://cloweshop.com/uploads/${id}.jpg`,
      `/uploads/${id}.jpg`,
      `asset:${id}/../x`,
      `asset:${id}?x=1`,
      'asset:',
      'asset:short',
      `ASSET:${id}`,
      ` asset:${id}x `,
      null,
      42,
    ]) {
      expect(isAssetRef(value), String(value)).toBe(false);
      expect(assetIdOf(value), String(value)).toBeNull();
    }
    expect(assetRefSchema.safeParse(`https://cloweshop.com/uploads/${id}.jpg`).success).toBe(false);
  });
});
