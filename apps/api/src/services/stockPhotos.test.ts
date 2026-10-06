import { describe, expect, it } from 'vitest';
import { isStockPhoto, withoutStockPhotos } from './stockPhotos';

describe('isStockPhoto', () => {
  it.each([
    'https://picsum.photos/seed/hero/1000/750',
    'https://fastly.picsum.photos/id/1/200/300.jpg',
    'http://loremflickr.com/640/480/shirt',
    'https://LOREMFLICKR.com/320/240',
  ])('%s is a stock photo', (url) => expect(isStockPhoto(url)).toBe(true));

  it.each([
    'https://cloweshop.com/uploads/1790884561392-daaeef5426b4.webp',
    '/uploads/fixture/x.jpg',
    'Picsum-style print tee', // a title, not a URL
    'https://example.com/?ref=picsum.photos', // the host is example.com
    'https://picsum.photos.evil.example/x.jpg',
  ])('%s is not', (value) => expect(isStockPhoto(value)).toBe(false));
});

describe('withoutStockPhotos', () => {
  it('nulls a stock photo field, drops one from a list, and leaves everything else as it was', () => {
    const body = {
      success: true,
      data: {
        banners: [{ id: 'b1', headline: 'Hello', imageUrl: 'https://picsum.photos/seed/a/1/1' }],
        gallery: ['https://picsum.photos/1', '/uploads/real.jpg', 'https://loremflickr.com/2'],
        logo: '/uploads/logo.png',
        count: 3,
        empty: null,
        when: '2026-10-07T00:00:00.000Z',
      },
    };
    expect(withoutStockPhotos(body)).toEqual({
      success: true,
      data: {
        banners: [{ id: 'b1', headline: 'Hello', imageUrl: null }],
        gallery: ['/uploads/real.jpg'],
        logo: '/uploads/logo.png',
        count: 3,
        empty: null,
        when: '2026-10-07T00:00:00.000Z',
      },
    });
  });
});
