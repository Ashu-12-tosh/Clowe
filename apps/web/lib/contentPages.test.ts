import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMERCIAL, POLICY_TOKENS, fillPolicyText, publicCommercial } from '@clowe/shared';
import { CONTENT_PAGES } from './contentPageList';
import { renderMarkdown } from './contentPages';
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
      // Old addresses and the current one alike: a page carries only the token.
      expect(read(page.slug), page.slug).not.toMatch(/NAJAFGARH|GOPAL NAGAR|MD MARG|SURAKH ?PUR|Defence En|Mohan Garden|Uttam Nagar|110059|110073|110043/i);
    }
  });

  it('the support FAQ carries no internal notes', () => {
    for (const e of FAQ_ENTRIES) expect(e.answer, e.label).not.toMatch(/TODO/);
  });
});

describe('renderMarkdown links', () => {
  it('keeps links to this site, anchors, http(s), mailto: and tel:', () => {
    const html = renderMarkdown('[a](/pages/faq) [b](#top) [c](https://cloweshop.com) [d](mailto:support@cloweshop.com) [e](tel:+911234567890)');
    expect(html.match(/<a href=/g)).toHaveLength(5);
    expect(html).toContain('href="/pages/faq"');
    expect(html).toContain('href="mailto:support@cloweshop.com"');
  });

  it('drops script links and keeps only their text', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '//evil.example']) {
      const html = renderMarkdown(`[click](${href})`);
      expect(html, href).not.toContain('<a ');
      expect(html, href).toContain('click');
    }
  });

  it('cannot break out of the href attribute', () => {
    const html = renderMarkdown('[x](https://a.example/" onmouseover="alert(1))');
    expect(html).not.toMatch(/onmouseover="/);
    expect(html).toContain('&quot;');
  });
});

describe('renderMarkdown tables', () => {
  const md = ['| Sl. No. | Head of Charge | Basis | Rate |', '| --- | --- | --- | --- |', '| 4 | Handling fee | Per unit | Below ₹500: ₹9<br>Premium plan: Nil |'].join('\n');

  it('render a real table from sm up, with its header row', () => {
    const html = renderMarkdown(md);
    expect(html).toContain('<table');
    expect(html).toContain('<thead class="hidden sm:table-header-group">');
    expect(html).toMatch(/<th scope="col"[^>]*>Head of Charge<\/th>/);
    expect(html).not.toContain('---');
  });

  it('stack on a phone: number and head in bold, then each column under its own label, each line on its own', () => {
    const html = renderMarkdown(md);
    expect(html).toMatch(/<td class="inline pr-1\.5 font-bold[^"]*">4<span class="sm:hidden">\.<\/span><\/td>/);
    expect(html).toMatch(/<td class="inline font-bold[^"]*">Handling fee<\/td>/);
    expect(html).toContain('<span class="font-semibold text-gray-500 sm:hidden">Basis:</span><span class="block">Per unit</span>');
    expect(html).toContain('<span class="font-semibold text-gray-500 sm:hidden">Rate:</span><span class="block">Below ₹500: ₹9</span><span class="block">Premium plan: Nil</span>');
  });

  it('escape a cell like any other text: only <br> breaks a line, links stay limited to safe targets', () => {
    const html = renderMarkdown(['| A | B |', '| --- | --- |', '| <script>x</script> | [ok](/pages/referral-fee-schedule) [bad](javascript:alert(1)) |'].join('\n'));
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<a href="/pages/referral-fee-schedule"');
    expect(html).not.toContain('javascript:');
  });
});

describe('Schedule II of the Seller Terms', () => {
  // With a referral fee schedule in force, as on production: the Rate cell links to it.
  const commercial = { ...publicCommercial(DEFAULT_COMMERCIAL), referral: { examples: [] } as unknown as ReturnType<typeof publicCommercial>['referral'] };
  const html = renderMarkdown(fillPolicyText(read('seller-terms'), { commercial, lateDispatchPenaltyPaise: 8000 }));
  const schedule = html.slice(html.indexOf('SCHEDULE II'));

  it('is a table of its 14 charges, with no "—" separators between the columns', () => {
    expect(schedule.match(/<tr class="block/g)).toHaveLength(14);
    for (const head of ['Referral fee', 'GT (goods transfer) charge', 'Handling fee', 'Seller plan', 'AI Try-On credits', 'Penalty — inaccurate product data supplied for AI Try-On']) {
      expect(schedule).toContain(`>${head}</td>`);
    }
    expect(schedule).not.toMatch(/Sl\. No\. — Head of Charge/);
  });

  it('puts each handling slab, plan and try-on pack on its own line, and keeps the Referral Fee Schedule link', () => {
    for (const line of ['Below ₹500: ₹9', '₹20,000 and above: ₹40', 'Premium plan: Nil', '100 credits ₹1,500']) {
      expect(schedule).toContain(`<span class="block">${line}</span>`);
    }
    expect(schedule.match(/<span class="block">(Free|Growth|Pro|Premium) (free|₹)/g)).toHaveLength(4);
    expect(schedule).toContain('<a href="/pages/referral-fee-schedule" class="font-semibold text-brand-600 hover:underline">Referral Fee Schedule</a>');
  });
});

describe('the grievance contact channels', () => {
  it('are a table: channel, details, hours', () => {
    const html = renderMarkdown(read('grievance-redressal'));
    expect(html.match(/<tr class="block/g)).toHaveLength(4);
    expect(html).toContain('<span class="font-semibold text-gray-500 sm:hidden">Details:</span><span class="block">support@cloweshop.com</span>');
    expect(html).not.toContain('Channel — Details — Hours');
  });
});
