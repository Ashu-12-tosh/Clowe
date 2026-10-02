import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RETURN_WINDOW_TOKEN, fillReturnWindow, returnWindowPhrase } from './returnWindow';

describe('the return window in copy', () => {
  it('fills every token from the setting', () => {
    const text = `Return within ${RETURN_WINDOW_TOKEN}. Yes, ${RETURN_WINDOW_TOKEN}.`;
    expect(fillReturnWindow(text, 5)).toBe('Return within 5 days. Yes, 5 days.');
    expect(fillReturnWindow(text, 1)).toBe('Return within 1 day. Yes, 1 day.');
  });

  it('says something true when the setting is not to hand', () => {
    expect(returnWindowPhrase(null)).toBe('the return window shown on the product page');
    expect(fillReturnWindow(`within ${RETURN_WINDOW_TOKEN}`, undefined)).not.toMatch(/\d/);
  });
});

/**
 * The window is one platform setting. Copy that writes a number of days next
 * to "return" has stopped reading it, so none may exist in the code, the
 * seeds or the content pages. Durations unrelated to returns ("5–7 business
 * days" for a refund) do not mention a return and are not caught; the few
 * that sit next to the word are listed in `unrelated`.
 */
describe('no hard-coded return window', () => {
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
  const days = String.raw`\b\d+\s*[- ]\s*days?\b`;
  const near = new RegExp(
    String.raw`${days}.{0,30}\breturns?\b|\b(returns?|window)\b.{0,30}${days}`,
    'i',
  );
  const unrelated = [
    /Last \d+ days/, // a chart's period on the returns dashboard
    /45 days after delivery/, // how long a packing video is kept
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
});
