import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Delivery is free on every order: buyers never pay a delivery fee, at any
 * order value, so no page may promise free delivery "above" an amount, quote
 * a delivery fee to buyers, or carry the old {{freeShippingFrom}} threshold
 * token (it is no longer filled, and would show as-is).
 */
describe('free delivery on all orders, in copy', () => {
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
  const threshold = new RegExp(
    String.raw`(${free}).{0,40}${amount}|${amount}.{0,40}(${free})|orders?\s+(above|over)\s+${amount}`,
    'i',
  );
  /** Buyer-facing wording of a delivery charge or a minimum for free delivery. */
  const buyerFee = /small delivery fee|delivery fee (applies|below)|to get free delivery|free (shipping|delivery) on orders (of|above|over)|\{\{freeShippingFrom\}\}/i;
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

  function hits(pattern: RegExp): string[] {
    const found: string[] = [];
    for (const dir of dirs) {
      for (const file of files(path.join(root, dir))) {
        fs.readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (pattern.test(line) && !unrelated.some((u) => u.test(line))) found.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    return found;
  }

  it('promises no free-delivery threshold anywhere', () => {
    expect(hits(threshold)).toEqual([]);
  });

  it('quotes buyers no delivery fee, and no page carries the old threshold token', () => {
    expect(hits(buyerFee)).toEqual([]);
  });

  it('says free delivery on all orders on the shipping pages and in the support answers', () => {
    const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
    expect(read('apps/web/content/pages/shipping-info.md')).toMatch(/Free delivery on all orders/);
    expect(read('apps/web/content/pages/shipping-policy.md')).toMatch(/free on all orders/);
    expect(read('apps/web/lib/support/faq-content.ts')).toMatch(/FREE delivery on every order/);
    expect(read('apps/web/components/UtilityBar.tsx')).toMatch(/on all orders/);
  });

  it('keeps no buyer delivery price in the API', () => {
    const delivery = fs.readFileSync(path.join(root, 'apps/api/src/services/deliveryService.ts'), 'utf8');
    expect(delivery).not.toMatch(/FREE_SHIPPING_THRESHOLD|SHIPPING_FEE_PAISE|EXPRESS_FEE|SAME_DAY_FEE/);
  });
});
