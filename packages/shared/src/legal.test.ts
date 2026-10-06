import { describe, expect, it } from 'vitest';
import { DEFAULT_LEGAL_ENTITY, fillLegalEntity, legalDisplayName } from './legal';

describe('legalDisplayName', () => {
  it('turns the registered capitals into a name for running text, keeping LLP', () => {
    expect(legalDisplayName('CLOWE PARTNERS LLP')).toBe('Clowe Partners LLP');
    expect(legalDisplayName('ACME RETAIL PVT. LTD.')).toBe('Acme Retail PVT. LTD.');
  });

  it("keeps a name the admin already styled", () => {
    expect(legalDisplayName('Clowe Partners LLP')).toBe('Clowe Partners LLP');
  });
});

describe('fillLegalEntity', () => {
  const page = [
    'Operated by **{{legal.name}}** ({{legal.displayName}}).',
    '- Registered address: {{legal.registeredAddress}}',
    '- LLPIN: {{legal.llpin}}',
    '- GSTIN: {{legal.gstin}}',
    '- Email: {{legal.supportEmail}}',
    '- Phone: {{legal.supportPhone}}',
    'Unrelated line.',
  ].join('\n');

  it('with only the seeded name, keeps that line and drops every empty field line', () => {
    expect(fillLegalEntity(page, DEFAULT_LEGAL_ENTITY)).toBe(
      ['Operated by **CLOWE PARTNERS LLP** (Clowe Partners LLP).', 'Unrelated line.'].join('\n'),
    );
  });

  it('fills every field that is set', () => {
    const out = fillLegalEntity(page, {
      ...DEFAULT_LEGAL_ENTITY,
      registeredAddress: '12 MG Road,\nBengaluru 560001',
      llpin: 'AAB-1234',
      supportPhone: '+91 98765 43210',
    });
    expect(out).toContain('- Registered address: 12 MG Road, Bengaluru 560001');
    expect(out).toContain('- LLPIN: AAB-1234');
    expect(out).toContain('- Phone: +91 98765 43210');
    expect(out).not.toContain('GSTIN');
    expect(out).not.toContain('Email');
  });

  it('falls back to the registered name when settings are unavailable', () => {
    expect(fillLegalEntity('By {{legal.name}}.', null)).toBe('By CLOWE PARTNERS LLP.');
  });

  it('takes markdown out of admin-typed values, so they cannot become links or formatting', () => {
    const out = fillLegalEntity('- Address: {{legal.registeredAddress}}', {
      ...DEFAULT_LEGAL_ENTITY,
      registeredAddress: '[click](javascript:alert(1)) **bold** `x`',
    });
    expect(out).toBe('- Address: click(javascript:alert(1)) bold x');
  });
});
