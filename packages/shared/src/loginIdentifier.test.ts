import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizePhone, parseLoginIdentifier, phoneSchema, pinSchema, signupSchema } from './auth';

/**
 * One normalisation for sign-up and login (pre-launch audit 2026-10-20, D1/D2):
 * a number or email stored one way and looked up another matched no account —
 * or the wrong one — and a correct PIN read as wrong.
 */
describe('normalizePhone', () => {
  it.each([
    ['9876543210', '9876543210'],
    ['+91 98765 43210', '9876543210'],
    ['+919876543210', '9876543210'],
    ['919876543210', '9876543210'],
    ['09876543210', '9876543210'],
    ['098765-43210', '9876543210'],
    ['(98765) 43210', '9876543210'],
    [' 98765\t43210 ', '9876543210'],
  ])('%j → %s', (raw, expected) => expect(normalizePhone(raw)).toBe(expected));

  it('never turns a +91 number into a different valid one', () => {
    // The old login box cut the raw text at 10 characters first: "919876543210"
    // became "9198765432" — a valid number, someone else's account.
    expect(phoneSchema.parse('919876543210')).toBe('9876543210');
    expect(phoneSchema.parse('+91 9876543210')).toBe('9876543210');
  });

  it('refuses what is not an Indian mobile number', () => {
    for (const bad of ['12345', '5876543210', '98765432101', '9198765432100', 'abc']) {
      expect(phoneSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail('  Asha.Rao@Example.COM ')).toBe('asha.rao@example.com');
  });
});

describe('parseLoginIdentifier', () => {
  it('reads a phone number in any written form', () => {
    expect(parseLoginIdentifier('+91 98765 43210')).toEqual({ kind: 'phone', value: '9876543210' });
  });
  it('reads an email in any case, with spaces around it', () => {
    expect(parseLoginIdentifier(' Asha@Example.com ')).toEqual({ kind: 'email', value: 'asha@example.com' });
  });
  it('refuses anything else', () => {
    for (const bad of ['', 'asha', 'asha@', '12345', '@example.com']) expect(parseLoginIdentifier(bad)).toBeNull();
  });
});

describe('pinSchema', () => {
  it('keeps a leading zero: a PIN is a string, never a number', () => {
    expect(pinSchema.parse('0123')).toBe('0123');
    expect(pinSchema.safeParse(123).success).toBe(false);
  });
  it('drops spaces a paste or password manager added', () => {
    expect(pinSchema.parse(' 1234 ')).toBe('1234');
    expect(pinSchema.parse('12 34')).toBe('1234');
  });
  it('refuses anything but four digits', () => {
    for (const bad of ['123', '12345', '12a4', '']) expect(pinSchema.safeParse(bad).success).toBe(false);
  });
});

describe('signupSchema', () => {
  const base = { name: 'Asha Rao', phone: '+91 98765 43210', phoneToken: 'x'.repeat(40), pin: '0123', confirmPin: '0123' };
  it('stores the number and email the way login looks them up', () => {
    expect(signupSchema.parse({ ...base, email: ' Asha@Example.com ' })).toMatchObject({ phone: '9876543210', email: 'asha@example.com' });
  });
  it('refuses PINs that differ', () => {
    const r = signupSchema.safeParse({ ...base, confirmPin: '0124' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['confirmPin']);
  });
});
