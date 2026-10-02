import { describe, expect, it } from 'vitest';
import { billedWeightGrams, oversizedBox, parcelProblems, volumetricWeightGrams } from './shipping';

describe('volumetric weight', () => {
  it('is L × W × H in cm ÷ 5000, in kg', () => {
    // 30 × 20 × 10 cm = 6000 cm³ ÷ 5000 = 1.2 kg.
    expect(volumetricWeightGrams(300, 200, 100)).toBe(1_200);
  });

  it('waits for all three sides', () => {
    expect(volumetricWeightGrams(300, 200, null)).toBeNull();
  });

  it('bills the larger of actual and volumetric', () => {
    expect(billedWeightGrams(350, 1_200)).toBe(1_200);
    expect(billedWeightGrams(2_000, 1_200)).toBe(2_000);
  });

  it('warns only when the box is more than twice the weight', () => {
    expect(oversizedBox(500, 1_000)).toBe(false);
    expect(oversizedBox(500, 1_001)).toBe(true);
    expect(oversizedBox(null, 1_000)).toBe(false);
  });
});

describe('parcelProblems', () => {
  it('is empty for a sensible parcel', () => {
    expect(parcelProblems({ weightGrams: 350, lengthMm: 300, widthMm: 200, heightMm: 50 })).toEqual([]);
  });

  it('asks for what is missing', () => {
    expect(parcelProblems({ weightGrams: null, lengthMm: 300 })).toEqual(['the item weight', 'the width', 'the height']);
  });

  it('catches a grams-for-kilograms slip and an impossible side', () => {
    expect(parcelProblems({ weightGrams: 350_000, lengthMm: 300, widthMm: 200, heightMm: 5 })).toEqual([
      'a weight between 0.01 kg and 100 kg',
      'a height between 1 cm and 300 cm',
    ]);
  });
});
