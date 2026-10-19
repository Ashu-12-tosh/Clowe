import { describe, expect, it } from 'vitest';
import { applyDigitInput } from './digitInput';

describe('applyDigitInput (PIN/OTP boxes)', () => {
  it('types one digit per box', () => {
    expect(applyDigitInput('', 0, '1', 4)).toEqual({ value: '1', focus: 1 });
    expect(applyDigitInput('12', 2, '3', 4)).toEqual({ value: '123', focus: 3 });
  });

  // The D2 cause: autofill put "1234" in the first box and only "4" was kept.
  it('takes a whole code autofilled or pasted into any box', () => {
    expect(applyDigitInput('', 0, '1234', 4)).toEqual({ value: '1234', focus: 3 });
    expect(applyDigitInput('9', 1, '0123', 4)).toEqual({ value: '0123', focus: 3 });
    expect(applyDigitInput('', 0, '482 913', 6)).toEqual({ value: '482913', focus: 5 });
  });

  it('keeps a leading zero', () => {
    expect(applyDigitInput('', 0, '0', 4).value).toBe('0');
    expect(applyDigitInput('', 0, '0007', 4).value).toBe('0007');
  });

  it('typing over a filled box on a keyboard that ignores maxLength keeps the new digit', () => {
    expect(applyDigitInput('1234', 1, '27', 4)).toEqual({ value: '1734', focus: 2 });
  });

  it('a partial paste fills from that box on', () => {
    expect(applyDigitInput('1', 1, '23', 4)).toEqual({ value: '123', focus: 3 });
  });

  it('clearing a box removes its digit', () => {
    expect(applyDigitInput('123', 2, '', 4)).toEqual({ value: '12', focus: 2 });
  });
});
