import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FREE_SHIPPING_TOKEN, fillPolicyText, freeShippingPhrase } from './policyText';

describe('the free-shipping threshold in copy', () => {
  it('fills every token from the setting', () => {
    const text = `Free delivery on orders ${FREE_SHIPPING_TOKEN}. Yes, orders ${FREE_SHIPPING_TOKEN}.`;
    expect(fillPolicyText(text, { freeShippingThresholdPaise: 99900 })).toBe(
      'Free delivery on orders of ₹999 or more. Yes, orders of ₹999 or more.',
    );
    expect(fillPolicyText(text, { freeShippingThresholdPaise: 150000 })).toContain('of ₹1,500 or more');
  });

  it('says something true when the setting is not to hand, or is zero', () => {
    expect(freeShippingPhrase(null)).toBe('above the amount shown at checkout');
    expect(fillPolicyText(`orders ${FREE_SHIPPING_TOKEN}`, null)).not.toMatch(/\d/);
    expect(freeShippingPhrase(0)).toBe('of any value');
  });
});

/**
 * The threshold is one platform setting (freeShippingThresholdPaise). Copy
 * that writes a rupee amount next to "free shipping/delivery" — or "orders
 * above ₹…" — has stopped reading it, so none may exist in the code, the seeds
 * or the content pages. The setting's default lives in settingsService.ts.
 */
describe('no hard-coded free-shipping threshold', () => {
  const root = path.resolve(__dirname, '../../..');
  const dirs = [
    'apps/web/app',
    'apps/web/components',
    'apps/web/lib',
    'apps/web/content',
    'apps/api/src',
    'apps/api/prisma/seed',
    'packages/shared/src',
  ];
  const free = String.raw`free\s+(standard\s+)?(shipping|delivery)|ships?\s+free`;
  const amount = String.raw`₹\s?\d[\d,]*`;
  const near = new RegExp(
    String.raw`(${free}).{0,40}${amount}|${amount}.{0,40}(${free})|orders?\s+(above|over)\s+${amount}`,
    'i',
  );
  const unrelated = [
    /No Cost EMI on orders above/, // a bank offer's minimum, not delivery
  ];

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...files(full));
      else if (/\.(ts|tsx|md)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('finds none', () => {
    const hits: string[] = [];
    for (const dir of dirs) {
      for (const file of files(path.join(root, dir))) {
        fs.readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (near.test(line) && !unrelated.some((u) => u.test(line))) hits.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(hits).toEqual([]);
  });

  it('keeps no threshold constant in the API', () => {
    const delivery = fs.readFileSync(path.join(root, 'apps/api/src/services/deliveryService.ts'), 'utf8');
    expect(delivery).not.toMatch(/FREE_SHIPPING_THRESHOLD/);
  });
});
