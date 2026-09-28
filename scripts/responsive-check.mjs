#!/usr/bin/env node
/**
 * Storefront responsive check — measures, rather than eyeballs.
 *
 *   node scripts/responsive-check.mjs [baseUrl]
 *
 * Needs `playwright` (a devDependency) and a browser. It uses Playwright's own
 * Chromium if present and otherwise drives a Chrome or Edge already installed,
 * so `npx playwright install` is optional rather than required.
 *
 * What it asserts, per page per width:
 *
 *   bodyOverflowPx === 0     The page body must never scroll sideways. Wide
 *                            content (tables, chip rows, category nav) is
 *                            expected to scroll inside its own container, so
 *                            anything with an overflow-x ancestor is ignored.
 *
 *   searchBoxPx >= MIN       The header search must stay usable. It regressed
 *                            to 14px at 360 because the logo and action icons
 *                            are shrink-0 and the flexible search absorbed the
 *                            whole shortfall; below md it is now an icon that
 *                            opens a full-width overlay, so what is measured
 *                            there is the overlay's box.
 *
 * Truncated text nodes are reported but not asserted on: `truncate` is
 * sometimes the right call (a seller name in a dense row), so the count is a
 * number to watch, not a gate.
 *
 * Exits non-zero if any assertion fails, so it can gate CI later.
 */

const BASE = process.argv[2] ?? 'http://localhost:4300';
const WIDTHS = [360, 390, 414]; // most Indian phones sit in this band
const PAGES = ['/', '/products', '/cart', '/track'];
/** Below this the field cannot show a useful amount of a query. */
const MIN_SEARCH_PX = 180;

/** Runs in the browser. Kept dependency-free so it can also be pasted into devtools. */
function measure() {
  const de = document.documentElement;

  const unclipped = [];
  document.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.right <= window.innerWidth + 1) return;
    // Ignore anything a scroller or clip already contains — that is the
    // intended pattern, not a defect.
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ov = getComputedStyle(p).overflowX;
      if (ov === 'auto' || ov === 'scroll' || ov === 'hidden') return;
    }
    unclipped.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').slice(0, 70),
      width: Math.round(r.width),
    });
  });

  let truncated = 0;
  document.querySelectorAll('.truncate').forEach((el) => {
    if (el.scrollWidth > Math.ceil(el.getBoundingClientRect().width)) truncated += 1;
  });

  // Below md the inline box is display:none and the icon opens an overlay, so
  // measure whichever search input is actually on screen.
  const input = [...document.querySelectorAll('header input')].find(
    (el) => el.getBoundingClientRect().width > 0,
  );

  /**
   * How much of the element a shopper can actually see.
   *
   * The element's own rect is not that number: the broken header rendered a
   * 68px input inside a 14px flex box, so its rect claimed 68 at every width
   * while only a sliver was on screen. Intersecting with every clipping
   * ancestor is what makes the measurement match the screenshot.
   */
  const visibleWidth = (el) => {
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    let left = r.left;
    let right = r.right;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (getComputedStyle(p).overflowX === 'visible') continue;
      const pr = p.getBoundingClientRect();
      left = Math.max(left, pr.left);
      right = Math.min(right, pr.right);
    }
    return Math.max(0, Math.min(right, window.innerWidth) - Math.max(left, 0));
  };

  const nav = [...document.querySelectorAll('header .overflow-x-auto')].find(
    (el) => el.scrollWidth > el.clientWidth + 1,
  );

  return {
    bodyOverflowPx: de.scrollWidth - de.clientWidth,
    unclippedCount: unclipped.length,
    unclipped: unclipped.slice(0, 5),
    searchBoxPx: Math.round(visibleWidth(input)),
    truncatedNodes: truncated,
    navScrollableBy: nav ? Math.round(nav.scrollWidth - nav.clientWidth) : 0,
  };
}

/** Opens the phone search overlay if this width has one. Returns true if opened. */
async function openSearchOverlay(page) {
  const icon = page.locator('header button[aria-label="Search"]');
  if ((await icon.count()) === 0 || !(await icon.first().isVisible())) return false;
  await icon.first().click();
  await page.locator('[role="dialog"][aria-label="Search"] input').waitFor({ timeout: 3000 });
  return true;
}

const { chromium } = await import('playwright').catch(() => {
  console.error('playwright is not installed. Run:  npm i -D playwright');
  process.exit(2);
});

/**
 * Prefer Playwright's own Chromium, but fall back to a Chrome or Edge already
 * on the machine. `npx playwright install` pulls ~150MB from a CDN that is not
 * always reachable, and this check needs a rendering engine, not that specific
 * build — every browser here computes the same layout for the assertions below.
 */
async function launch() {
  const attempts = [
    ['bundled chromium', {}],
    ['system chrome', { channel: 'chrome' }],
    ['system edge', { channel: 'msedge' }],
  ];
  const failures = [];
  for (const [label, options] of attempts) {
    try {
      const browser = await chromium.launch(options);
      console.log(`browser: ${label}`);
      return browser;
    } catch (err) {
      failures.push(`  ${label}: ${String(err.message).split('\n')[0].slice(0, 100)}`);
    }
  }
  console.error('No usable browser found.\n' + failures.join('\n') +
    '\nInstall one with:  npx playwright install chromium');
  process.exit(2);
}

const browser = await launch();
const rows = [];
let failures = 0;

for (const path of PAGES) {
  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 780 } });
    try {
      await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 20000 });
      const overlayed = await openSearchOverlay(page);
      const m = await page.evaluate(measure);

      const overflowBad = m.bodyOverflowPx > 0 || m.unclippedCount > 0;
      const searchBad = m.searchBoxPx > 0 && m.searchBoxPx < MIN_SEARCH_PX;
      if (overflowBad || searchBad) failures += 1;

      rows.push({
        page: path,
        w: width,
        overflow: m.bodyOverflowPx,
        unclipped: m.unclippedCount,
        search: m.searchBoxPx + (overlayed ? ' (overlay)' : ''),
        navScroll: m.navScrollableBy,
        trunc: m.truncatedNodes,
        ok: overflowBad || searchBad ? 'FAIL' : 'ok',
      });
      if (m.unclippedCount > 0) {
        console.error(`\n${path} @${width} — elements overflowing the viewport:`);
        for (const o of m.unclipped) console.error(`   <${o.tag}> ${o.width}px  ${o.cls}`);
      }
    } catch (err) {
      failures += 1;
      rows.push({ page: path, w: width, overflow: '-', unclipped: '-', search: '-',
                  navScroll: '-', trunc: '-', ok: `ERROR ${err.message.slice(0, 40)}` });
    } finally {
      await page.close();
    }
  }
}

await browser.close();
console.table(rows);
console.log(
  failures === 0
    ? `\nAll ${rows.length} checks passed (body overflow 0, search >= ${MIN_SEARCH_PX}px).`
    : `\n${failures} of ${rows.length} checks FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
