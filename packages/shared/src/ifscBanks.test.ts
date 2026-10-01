import { describe, expect, it } from 'vitest';
import { bankNameFromIfsc } from './ifscBanks';

describe('bankNameFromIfsc', () => {
  it('names the bank from the prefix', () => {
    expect(bankNameFromIfsc('HDFC0001234')).toBe('HDFC Bank');
    expect(bankNameFromIfsc('SBIN0000001')).toBe('State Bank of India');
    expect(bankNameFromIfsc('UTIB0000005')).toBe('Axis Bank');
  });

  it('is not fussy about how it was typed', () => {
    expect(bankNameFromIfsc('  hdfc0001234 ')).toBe('HDFC Bank');
  });

  it('says nothing for a prefix it does not know, rather than guessing', () => {
    expect(bankNameFromIfsc('ZZZZ0001234')).toBeNull();
  });

  it('says nothing for something that is not an IFSC yet', () => {
    // Half-typed codes must not fill the field with a wrong bank.
    expect(bankNameFromIfsc('HDFC')).toBeNull();
    expect(bankNameFromIfsc('HDFC000')).toBeNull();
    expect(bankNameFromIfsc('')).toBeNull();
  });
});
