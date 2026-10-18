import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POLICY_TOKENS } from '@clowe/shared';
import { CONTENT_PAGES } from './contentPageList';
import { FAQ_ENTRIES } from './support/faq-content';

const PAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content', 'pages');
const read = (slug: string) => fs.readFileSync(path.join(PAGES, `${slug}.md`), 'utf8');
const LEGAL_TOKEN = /^\{\{legal\.(name|displayName|entityType|registeredAddress|llpin|gstin|pan|supportEmail|supportPhoneAlt|supportPhone)\}\}$/;

/** The pages that state rules a buyer or seller is held to. */
const POLICY_PAGES = [
  'terms-conditions', 'customer-terms-of-sale', 'privacy-policy', 'shipping-policy', 'return-policy',
  'cancellation', 'payment-policy', 'cookie-policy', 'faq', 'help',
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

  it('the seller fee page states no fee as a number of its own', () => {
    // Its fees come from settings tokens, so a change in admin shows there at once. (The
    // lawyer's documents are published word for word, numbers included.)
    for (const slug of ['seller-fees']) {
      expect(read(slug), slug).not.toMatch(/₹\s?\d|\d+(\.\d+)?\s?%/);
    }
  });

  it('leave nothing to fill in', () => {
    for (const page of CONTENT_PAGES) expect(read(page.slug), page.slug).not.toMatch(/TO FILL|TODO|\[placeholder|\[INSERT/i);
  });

  it('the Blog and the App page stay unlisted (404) until they have real content', () => {
    for (const slug of ['blog', 'app']) expect(CONTENT_PAGES.some((p) => p.slug === slug), slug).toBe(false);
  });

  it('describe no feature Clowe does not have: those pages are gone (and 404)', () => {
    for (const slug of ['affiliate', 'recalls', 'accelerator', 'purchase-protection', 'shipping-info', 'returns-refunds']) {
      expect(CONTENT_PAGES.some((p) => p.slug === slug), slug).toBe(false);
      expect(fs.existsSync(path.join(PAGES, `${slug}.md`)), slug).toBe(false);
    }
  });

  it('never hard-code the company address: it comes from Admin -> Settings -> Legal ({{legal.registeredAddress}})', () => {
    for (const page of CONTENT_PAGES) {
      expect(read(page.slug), page.slug).not.toMatch(/NAJAFGARH|GOPAL NAGAR|Defence En|Mohan Garden|Uttam Nagar|110059|110073/i);
    }
  });

  it('the support FAQ carries no internal notes', () => {
    for (const e of FAQ_ENTRIES) expect(e.answer, e.label).not.toMatch(/TODO/);
  });
});
