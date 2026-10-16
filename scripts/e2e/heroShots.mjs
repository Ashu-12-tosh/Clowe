// Every home hero slide, one screenshot each, at computer, small-laptop and
// phone width. Read-only.
//   node scripts/e2e/heroShots.mjs <outDir> <baseUrl>
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const [outDir, base] = process.argv.slice(2);
if (!outDir || !base) {
  console.error('usage: heroShots.mjs <outDir> <baseUrl>');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const width of [1440, 1024, 390]) {
    const phone = width < 600;
    const context = await browser.newContext({
      viewport: { width, height: phone ? 844 : 900 },
      deviceScaleFactor: phone ? 3 : 1,
      isMobile: phone,
      hasTouch: phone,
    });
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'networkidle', timeout: 60_000 });
    const hero = page.locator('section[aria-roledescription=carousel]').first();
    await hero.waitFor();
    // Stop the rotation: it pauses while the pointer is over it.
    await hero.hover().catch(() => {});
    const dots = hero.locator('button[aria-label^="Slide "]');
    const count = Math.max(await dots.count(), 1);
    for (let i = 0; i < count; i++) {
      if (count > 1) await dots.nth(i).click();
      // The slide in place and its picture loaded.
      await page.waitForTimeout(900);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(400);
      const file = path.join(outDir, `home-hero-${i + 1}-${width}.png`);
      await hero.screenshot({ path: file });
      console.log(file);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
