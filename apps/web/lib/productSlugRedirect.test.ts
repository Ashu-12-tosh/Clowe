import { describe, expect, it } from 'vitest';
import { renamedProductPath } from './productSlugRedirect';

const MAP = { 'men-shirt-men-shirt-973465': 'nitin-chhikara-teal-checked-cotton-men-s-shirt-973465' };

describe('renamedProductPath', () => {
  it('sends an old product slug to the current one', () => {
    expect(renamedProductPath('/products/men-shirt-men-shirt-973465', MAP)).toBe(
      '/products/nitin-chhikara-teal-checked-cotton-men-s-shirt-973465',
    );
  });

  it('keeps the rest of the path (the try-on page)', () => {
    expect(renamedProductPath('/products/men-shirt-men-shirt-973465/tryon', MAP)).toBe(
      '/products/nitin-chhikara-teal-checked-cotton-men-s-shirt-973465/tryon',
    );
  });

  it('leaves current slugs, other pages and malformed paths alone', () => {
    expect(renamedProductPath('/products/nitin-chhikara-teal-checked-cotton-men-s-shirt-973465', MAP)).toBeNull();
    expect(renamedProductPath('/products', MAP)).toBeNull();
    expect(renamedProductPath('/store/men-shirt-men-shirt-973465', MAP)).toBeNull();
    expect(renamedProductPath('/products/%E0%A4%A', MAP)).toBeNull();
  });

  it('never redirects a slug to itself', () => {
    expect(renamedProductPath('/products/a', { a: 'a' })).toBeNull();
  });
});
