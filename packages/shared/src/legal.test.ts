import { describe, expect, it } from 'vitest';
import { DEFAULT_LEGAL_ENTITY, fillLegalEntity, legalDisplayName, legalEntityType } from './legal';

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

  // Owner, 24 Oct 2026: public pages name only the legal name and email
  // addresses. Tax invoices, credit notes and labels are not filled from here.
  const full = {
    ...DEFAULT_LEGAL_ENTITY,
    registeredAddress: 'H. No. 22-A, Ground Floor, Pole 43, Surakh Pur Road, Gali No. 21, Najafgarh, New Delhi 110043',
    llpin: 'ADB-3171',
    gstin: '07AAWFC9519L1ZL',
    supportEmail: 'support@cloweshop.com',
    supportPhone: '+91 8929316316',
    supportPhoneAlt: '8929314314',
  };

  it('fills the name and email, and never the address, LLPIN, GSTIN or phones', () => {
    const out = fillLegalEntity(page, full);
    expect(out.split('\n')).toEqual(['Operated by **CLOWE PARTNERS LLP** (Clowe Partners LLP).', '- Email: support@cloweshop.com', 'Unrelated line.']);
  });

  it('cuts the address, GSTIN and PAN out of a sentence and keeps the rest of it', () => {
    expect(fillLegalEntity('Operated by CLOWE PARTNERS LLP (GSTIN {{legal.gstin}}, PAN {{legal.pan}}), registered office at {{legal.registeredAddress}}', full)).toBe(
      'Operated by CLOWE PARTNERS LLP',
    );
    expect(fillLegalEntity('Name: Amit Designation: Grievance officer Address: {{legal.registeredAddress}} E-mail:  support@cloweshop.com', full)).toBe(
      'Name: Amit Designation: Grievance officer E-mail:  support@cloweshop.com',
    );
  });

  it('drops a line that only gives a phone number', () => {
    expect(fillLegalEntity(['Call {{legal.supportPhone}} or {{legal.supportPhoneAlt}}.', 'Kept.'].join('\n'), full)).toBe('Kept.');
  });

  it('falls back to the registered name when settings are unavailable', () => {
    expect(fillLegalEntity('By {{legal.name}}.', null)).toBe('By CLOWE PARTNERS LLP.');
  });

  it('takes markdown out of admin-typed values, so they cannot become links or formatting', () => {
    const out = fillLegalEntity('- Name: {{legal.name}}', {
      ...DEFAULT_LEGAL_ENTITY,
      name: '[click](javascript:alert(1)) **bold** `x`',
    });
    expect(out).toBe('- Name: click(javascript:alert(1)) bold x');
    // A line that is only the address goes, never leaving a stray "-".
    expect(fillLegalEntity('- Address: {{legal.registeredAddress}}\nKept.', { ...DEFAULT_LEGAL_ENTITY, registeredAddress: 'X' })).toBe('Kept.');
  });
});

describe('legalEntityType', () => {
  it('reads the entity type off the registered name', () => {
    expect(legalEntityType('CLOWE PARTNERS LLP')).toBe('Limited Liability Partnership (LLP)');
    expect(legalEntityType('Acme Retail Pvt. Ltd.')).toBe('Private Limited Company');
    expect(legalEntityType('ACME RETAIL PRIVATE LIMITED')).toBe('Private Limited Company');
    expect(legalEntityType('ACME LIMITED')).toBe('Public Limited Company');
  });

  it('is empty when the name does not say, and the token line then drops out', () => {
    expect(legalEntityType('Clowe')).toBe('');
    expect(fillLegalEntity('Type: {{legal.entityType}}\nKept.', { ...DEFAULT_LEGAL_ENTITY, name: 'Clowe' })).toBe('Kept.');
    expect(fillLegalEntity('Type: {{legal.entityType}}', DEFAULT_LEGAL_ENTITY)).toBe('Type: Limited Liability Partnership (LLP)');
  });
});

describe('the actual policy pages', () => {
  it('leave no address, phone number, GSTIN, PAN or LLPIN on any of them', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.resolve(__dirname, '../../../apps/web/content/pages');
    const legal = {
      ...DEFAULT_LEGAL_ENTITY,
      registeredAddress: 'H. No. 22-A, Ground Floor, Pole 43, Surakh Pur Road, Gali No. 21, Najafgarh, New Delhi 110043',
      llpin: 'ADB-3171',
      gstin: '07AAWFC9519L1ZL',
      supportEmail: 'support@cloweshop.com',
      supportPhone: '+91 8929316316',
      supportPhoneAlt: '8929314314',
    };
    for (const file of fs.readdirSync(dir).filter((f: string) => f.endsWith('.md'))) {
      const out = fillLegalEntity(fs.readFileSync(path.join(dir, file), 'utf8'), legal);
      for (const hidden of ['Najafgarh', '110043', '8929316316', '8929314314', '07AAWFC9519L1ZL', 'AAWFC9519L', 'ADB-3171', 'WhatsApp —']) {
        expect({ file, hidden, found: out.includes(hidden) }).toEqual({ file, hidden, found: false });
      }
      expect({ file, legalName: out.includes('CLOWE PARTNERS LLP') || !fs.readFileSync(path.join(dir, file), 'utf8').includes('CLOWE PARTNERS LLP') }).toEqual({ file, legalName: true });
    }
  });
});
