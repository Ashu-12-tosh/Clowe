// Measures every carousel's height on every slide, at several widths, and the
// page's layout shift (CLS) on first load. Read-only.
//   node scripts/e2e/carouselHeights.mjs <baseUrl> <path> [<path> ...]
// A carousel is the home hero (section[aria-roledescription=carousel]) or a
// category banner ([data-carousel]); its slide buttons are clicked in turn.
import { chromium } from 'playwright';

const [base, ...paths] = process.argv.slice(2);
const WIDTHS = (process.env.WIDTHS ?? '1440,1024,768,390').split(',').map(Number);
const browser = await chromium.launch({ channel: 'chrome' });
const results = [];
try {
  for (const width of WIDTHS) {
    const phone = width < 600;
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
    for (const p of paths) {
      const page = await context.newPage();
      await page.addInitScript(() => {
        window.__cls = 0;
        window.__shifts = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.hadRecentInput) continue;
            window.__cls += e.value;
            const src = (e.sources ?? []).map((s) => {
              const n = s.node;
              if (!n || !n.tagName) return '?';
              return `${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}.${String(n.className ?? '').split(' ').slice(0, 3).join('.')} ${Math.round(s.previousRect.height)}→${Math.round(s.currentRect.height)}@${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)}`;
            });
            window.__shifts.push(`${e.value.toFixed(3)} ${src.join(' | ')}`);
          }
        }).observe({ type: 'layout-shift', buffered: true });
      });
      await page.goto(new URL(p, base).toString(), { waitUntil: 'networkidle', timeout: 60_000 });
      await page.waitForTimeout(1500);
      const cls = await page.evaluate(() => window.__cls);
      if (process.env.SHIFTS) for (const line of await page.evaluate(() => window.__shifts)) console.log('    shift', line.slice(0, 220));
      const carousel = page.locator('section[aria-roledescription=carousel], [data-carousel]').first();
      const heights = [];
      if (await carousel.count()) {
        await carousel.hover().catch(() => {});
        const dots = carousel.locator('button[aria-label^="Slide "], button[aria-label^="Go to slide"]');
        const n = Math.max(await dots.count(), 1);
        for (let i = 0; i < n; i++) {
          if (n > 1) await dots.nth(i).click();
          await page.waitForTimeout(700);
          heights.push(Math.round((await carousel.boundingBox())?.height ?? 0));
        }
      }
      const same = heights.length > 0 && heights.every((h) => h === heights[0]);
      results.push({ width, page: p, heights, same, cls: +cls.toFixed(4) });
      console.log(`${String(width).padStart(4)} ${p.padEnd(24)} slides ${heights.join(' / ') || '—'} ${heights.length ? (same ? 'SAME' : 'JUMPS') : ''}  CLS ${cls.toFixed(4)}`);
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
}
