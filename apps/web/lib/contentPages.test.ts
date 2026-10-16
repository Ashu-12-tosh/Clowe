import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POLICY_TOKENS } from '@clowe/shared';
import { CONTENT_PAGES } from './contentPageList';
import { FAQ_ENTRIES } from './support/faq-content';

const PAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content', 'pages');
const read = (slug: string) => fs.readFileSync(path.join(PAGES, `${slug}.md`), 'utf8');
const LEGAL_TOKEN = /^\{\{legal\.(name|displayName|registeredAddress|llpin|gstin|supportEmail|supportPhone)\}\}$/;

/** The pages that state rules a buyer or seller is held to. */
const POLICY_PAGES = [
  'terms-conditions', 'privacy-policy', 'shipping-policy', 'shipping-info', 'return-policy', 'returns-refunds',
  'cancellation', 'payment-policy', 'cookie-policy', 'faq', 'help', 'purchase-protection',
  'seller-terms', 'seller-fees', 'grievance-redressal',
];

describe('content pages', () => {
  it('every listed page has its markdown', () => {
    for (const page of CONTENT_PAGES) expect(fs.existsSync(path.join(PAGES, `${page.slug}.md`)), page.slug).toBe(true);
  });

  it('use only tokens the page knows how to fill', () => {
    for (const page of CONTENT_PAGES) {
      const unknown = (read(page.slug).match(/\{\{[^}]+\}\}/g) ?? []).filter((t) => !POLICY_TOKENS.includes(t) && !LEGAL_TOKEN.test(t));
      expect(unknown, page.slug).toEqual([]);
    }
  });

  it('every policy page says when it was last updated', () => {
    for (const slug of POLICY_PAGES) {
      expect(CONTENT_PAGES.some((p) => p.slug === slug), slug).toBe(true);
      expect(read(slug), slug).toMatch(/^\*Last updated: \d{1,2} [A-Z][a-z]+ \d{4}\*$/m);
    }
  });

  it('state no fee, limit or rate as a number of their own', () => {
    // Fees, limits and rates come from settings tokens, so a change in admin shows everywhere.
    for (const slug of ['seller-terms', 'seller-fees', 'payment-policy', 'terms-conditions']) {
      expect(read(slug), slug).not.toMatch(/₹\s?\d|\d+(\.\d+)?\s?%/);
    }
  });

  it('the support FAQ carries no internal notes', () => {
    for (const e of FAQ_ENTRIES) expect(e.answer, e.label).not.toMatch(/TODO/);
  });
});
