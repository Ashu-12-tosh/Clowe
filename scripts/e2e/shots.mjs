// Screenshots of public pages at computer and phone width, read-only.
//   node scripts/e2e/shots.mjs <outDir> <baseUrl> <path> [<path> ...]
// Each page is shot at 1440 and 390 wide (full page), named after its path
// (SHOT_WIDTHS=1440,1024,390 for others).
// Also reports any image drawn smaller than it is shown (blurry) and any
// <img> squashed out of its natural shape.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const [outDir, base, ...paths] = process.argv.slice(2);
if (!outDir || !base || paths.length === 0) {
  console.error('usage: shots.mjs <outDir> <baseUrl> <path> [...]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
// SHOT_WIDTHS=1440,1024,390 to choose the widths.
const WIDTHS = (process.env.SHOT_WIDTHS ?? '1440,390').split(',').map(Number);
const nameOf = (p) => (p === '/' ? 'home' : p.replace(/^\//, '').replace(/[/?=&]+/g, '_'));

const browser = await chromium.launch({ channel: 'chrome' });
const report = [];
try {
  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: width < 600 ? 844 : 900 },
      deviceScaleFactor: width < 600 ? 3 : 1,
      isMobile: width < 600,
      hasTouch: width < 600,
    });
    const page = await context.newPage();
    for (const p of paths) {
      const url = new URL(p, base).toString();
      const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 }).catch((e) => ({ status: () => `error ${e.message}` }));
      // Scroll through so lazy images load, then back to the top. A page that
      // moves on by itself (a client redirect) is followed once.
      const scroll = () =>
        page.evaluate(async () => {
          for (let y = 0; y < document.body.scrollHeight; y += 600) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 120));
          }
          window.scrollTo(0, 0);
        });
      await scroll().catch(async () => {
        await page.waitForLoadState('networkidle').catch(() => {});
        await scroll();
      });
      await page.waitForTimeout(800);
      const file = path.join(outDir, `${nameOf(p)}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      // The first screen on its own, to see at a glance.
      await page.screenshot({ path: file.replace(/\.png$/, '-top.png') });
      const images = await page.evaluate(() =>
        [...document.images]
          .filter((img) => img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width > 40)
          .map((img) => {
            const r = img.getBoundingClientRect();
            const fit = getComputedStyle(img).objectFit;
            return {
              src: (img.currentSrc || img.src).split('/').pop(),
              shown: `${Math.round(r.width)}x${Math.round(r.height)}`,
              natural: `${img.naturalWidth}x${img.naturalHeight}`,
              // Pixels per CSS pixel the image has across the box it fills.
              density: +(img.naturalWidth / r.width).toFixed(2),
              squashed: fit === 'fill' && Math.abs(img.naturalWidth / img.naturalHeight - r.width / r.height) > 0.03,
              cropped: fit === 'cover' && Math.abs(img.naturalWidth / img.naturalHeight - r.width / r.height) > 0.03,
            };
          }),
      );
      report.push({ page: p, landed: new URL(page.url()).pathname, width, status: res?.status?.(), file: path.basename(file), images });
    }
    await context.close();
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
for (const r of report) {
  const flags = r.images.filter((i) => i.squashed || i.cropped || i.density < 1);
  console.log(`${r.width} ${r.page}${r.landed !== r.page ? ` (landed on ${r.landed})` : ''} → ${r.file} (HTTP ${r.status}) ${flags.length ? '' : 'ok'}`);
  for (const i of flags) console.log(`    ${i.src} shown ${i.shown} natural ${i.natural} density ${i.density}${i.squashed ? ' SQUASHED' : ''}${i.cropped ? ' cropped' : ''}`);
}
