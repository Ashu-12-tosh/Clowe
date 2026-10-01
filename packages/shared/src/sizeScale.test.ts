import { describe, expect, it } from 'vitest';
import { compareSizes, sizeScaleOf } from './sizeScale';

describe('sizeScaleOf', () => {
  it('recognises every scale the catalog sells in', () => {
    expect(sizeScaleOf('M')).toBe('alpha');
    expect(sizeScaleOf('xxl')).toBe('alpha');
    expect(sizeScaleOf('2XL')).toBe('alpha');
    expect(sizeScaleOf('32')).toBe('waist');
    expect(sizeScaleOf('UK 7')).toBe('uk');
    expect(sizeScaleOf('UK7')).toBe('uk');
    expect(sizeScaleOf('2-3Y')).toBe('age');
    expect(sizeScaleOf('4-5 yrs')).toBe('age');
    expect(sizeScaleOf('0-3M')).toBe('age');
    expect(sizeScaleOf('42mm')).toBe('length_mm');
    expect(sizeScaleOf('24 cm')).toBe('length_cm');
    expect(sizeScaleOf('55 inch')).toBe('inch');
    expect(sizeScaleOf('6.5"')).toBe('inch');
    expect(sizeScaleOf('Free Size')).toBe('free');
    expect(sizeScaleOf('One Size')).toBe('free');
  });

  it('files what it does not recognise under other, never a guess', () => {
    expect(sizeScaleOf('Zorb')).toBe('other');
    expect(sizeScaleOf('')).toBe('other');
    expect(sizeScaleOf('EU 42')).toBe('other');
  });
});

describe('compareSizes', () => {
  it('orders letter sizes in wearing order, not alphabetically', () => {
    expect(['XL', 'S', 'M', 'XS', 'XXL', 'L', '2XL'].sort(compareSizes)).toEqual(['XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL']);
  });

  it('orders numbers numerically, so 8 sits before 10', () => {
    expect(['36', '28', '30', '8', '10'].sort(compareSizes)).toEqual(['8', '10', '28', '30', '36']);
    expect(['UK 10', 'UK 8', 'UK 6', 'UK 7'].sort(compareSizes)).toEqual(['UK 6', 'UK 7', 'UK 8', 'UK 10']);
    expect(['46mm', '41mm', '42mm'].sort(compareSizes)).toEqual(['41mm', '42mm', '46mm']);
    expect(['65 inch', '43 inch', '55 inch'].sort(compareSizes)).toEqual(['43 inch', '55 inch', '65 inch']);
  });

  it('orders age bands by their lower bound, months before years', () => {
    expect(['6-7Y', '2-3Y', '0-3M', '8-9Y', '4-5Y'].sort(compareSizes)).toEqual(['0-3M', '2-3Y', '4-5Y', '6-7Y', '8-9Y']);
  });

  it('groups mixed scales in a fixed order so a facet reads sensibly', () => {
    const mixed = ['55 inch', 'Zorb', 'M', 'UK 7', '32', '2-3Y', '42mm', '24 cm', 'Free Size', 'S', '28', 'Alpha'];
    expect(mixed.sort(compareSizes)).toEqual([
      'S', 'M',
      '28', '32',
      'UK 7',
      '2-3Y',
      '42mm',
      '24 cm',
      '55 inch',
      'Free Size',
      'Alpha', 'Zorb',
    ]);
  });

  it('is a consistent comparator: equal values compare 0 and the order is antisymmetric', () => {
    expect(compareSizes('M', 'M')).toBe(0);
    expect(Math.sign(compareSizes('S', 'XL'))).toBe(-Math.sign(compareSizes('XL', 'S')));
    expect(Math.sign(compareSizes('32', 'UK 6'))).toBe(-Math.sign(compareSizes('UK 6', '32')));
  });
});
