#!/usr/bin/env node
/**
 * Storefront responsive check — measures, rather than eyeballs.
 *
 *   node scripts/responsive-check.mjs [baseUrl] [--phone=<10 digits>] [--only=/seller,/admin]
 *
 * --only keeps the pages whose path starts with one of the given prefixes.
 *
 * Needs `playwright` (a devDependency) and a browser. It uses Playwright's own
 * Chromium if present and otherwise drives a Chrome or Edge already installed,
 * so `npx playwright install` is optional rather than required.
 *
 * Widths run from 360 (most Indian phones sit in 360–414) through tablet
 * (768, 820, 1024 — an iPad in each orientation) to 1280 and 1920, because
 * the cart's table collided at exactly 1024 while passing at the phone widths
 * this used to check, and nothing below 768 would ever have shown it.
 *
 * Pages: home, the listing, one product page (the first the API lists), the
 * cart with an item in it, checkout, and tracking. The cart and checkout need
 * a signed-in shopper with something in the cart, so against a local server
 * the script signs one in through the dev OTP (the code comes back in the
 * response when the API is not in production), adds the first variant of the
 * first product, and clears the cart again at the end. Against any other
 * host it does not try: pass --phone=... to opt in, and the OTP has to be
 * real. Without a session those two pages are skipped and the summary says so.
 *
 * What it asserts, per page per width:
 *
 *   bodyOverflowPx === 0     The page body must never scroll sideways. Wide
 *                            content (tables, chip rows, category nav) is
 *                            expected to scroll inside its own container, so
 *                            anything with an overflow-x ancestor is ignored.
 *
 *   scrollableCount === 0    On seller pages, no horizontal scroller inside the
 *                            page either. The products table scrolled sideways
 *                            at every laptop width while the body did not, so
 *                            neither assertion above could see it — and a
 *                            seller scrolling a table loses the product names
 *                            off its left edge. Storefront pages keep their
 *                            intended scrollers (category nav, carousels).
 *
 * The seller's products page runs signed in as the demo seller (9000000001,
 * from the seed) on localhost; elsewhere pass --seller-phone=... .
 *
 *   clippedTextCount === 0   Nothing readable may be cut off at the viewport
 *                            edge by an overflow-hidden ancestor either. The
 *                            cart at 768 laid its single grid column out at
 *                            the width of a product scroller inside it —
 *                            about 1950px — and a clip higher up hid the
 *                            result: the body did not scroll, so the first
 *                            assertion passed, while the order summary's
 *                            amounts were simply off the right of the page.
 *                            Elements inside a scroller (overflow auto or
 *                            scroll) or a transformed track (the carousel
 *                            moves its slides with translateX) are the
 *                            intended pattern and are not counted.
 *
 *   searchBoxPx >= MIN       The header search must stay usable. It regressed
 *                            to 14px at 360 because the logo and action icons
 *                            are shrink-0 and the flexible search absorbed the
 *                            whole shortfall; below md it is now an icon that
 *                            opens a full-width overlay, so what is measured
 *                            there is the overlay's box.
 *
 *   rail                     On listings, the filter rail must be reachable:
 *                            from 1024 up as the sidebar, below it as the
 *                            bottom sheet the Filters button opens — which
 *                            must fit the viewport and not scroll sideways.
 *                            Checked on all products, a filtered search and
 *                            a filtered category, so the applied-filter chips
 *                            are on the page too.
 *
 * Every seller and admin page is checked too (signed in as the demo seller
 * and the admin on localhost; elsewhere pass --seller-phone / --admin-phone),
 * with two more assertions, because a label cut short there is a label the
 * seller or admin cannot read:
 *
 *   cut === 0                Text cut with an ellipsis or a line clamp, with
 *                            no title to read it whole. Truncating a long
 *                            product name in a dense row is fine when the full
 *                            name is on hover; silently is not.
 *
 *   spill === 0              Text running past the box it sits in — a card,
 *                            a bordered cell, a pill — rather than wrapping.
 *                            A scroller is expected to hold more than it
 *                            shows, so text inside one is not counted.
 *
 * Truncated text nodes are reported but not asserted on: `truncate` is
 * sometimes the right call (a seller name in a dense row), so the count is a
 * number to watch, not a gate.
 *
 * Exits non-zero if any assertion fails, so it can gate CI later.
 */

const argv = process.argv.slice(2);
const BASE = (argv.find((a) => !a.startsWith('--')) ?? 'http://localhost:4300').replace(/\/$/, '');
const PHONE = argv.find((a) => a.startsWith('--phone='))?.slice('--phone='.length);
const SELLER_PHONE = argv.find((a) => a.startsWith('--seller-phone='))?.slice('--seller-phone='.length);
const ADMIN_PHONE = argv.find((a) => a.startsWith('--admin-phone='))?.slice('--admin-phone='.length);
const ONLY = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean);
/** The seeded admin on a local database (ADMIN_PHONE in apps/api/.env). */
const DEMO_ADMIN_PHONE = '9999999999';
const DEMO_SELLER_PHONE = '9000000001';
/** Width and a height typical of a device that width. */
const VIEWPORTS = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
  { width: 768, height: 1024 },
  { width: 820, height: 1180 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];
/** Pages that need a signed-in shopper with a cart. */
const AUTH_PAGES = new Set(['/cart', '/checkout']);
/** The seller page that also gets the no-scroller assertion (see the header). */
const NO_SCROLLER_PAGES = new Set(['/seller/products']);
/** Seller and admin pages without an id in them; the ones with ids are added once known. */
const SELLER_PAGE_PATHS = [
  '/seller', '/seller/ads', '/seller/ads/new', '/seller/customers', '/seller/inventory', '/seller/orders',
  '/seller/payouts', '/seller/products', '/seller/products/new', '/seller/promotions', '/seller/returns',
  '/seller/settings', '/seller/support', '/seller/tryon',
];
/** Seller pages anyone can open: checked signed out. */
const SELLER_PUBLIC_PATHS = ['/seller/login', '/seller/register'];
const ADMIN_PAGE_PATHS = [
  '/admin', '/admin/ads', '/admin/audit', '/admin/banners', '/admin/brands', '/admin/categories',
  '/admin/csp-reports', '/admin/deals', '/admin/facets', '/admin/inventory', '/admin/newsletter', '/admin/orders',
  '/admin/payments', '/admin/products', '/admin/promos', '/admin/returns', '/admin/search', '/admin/seller-referrals',
  '/admin/sellers', '/admin/settings', '/admin/support', '/admin/tryon', '/admin/users',
];
/** Listings that carry the filter rail. */
const RAIL_PAGES = new Set([
  '/products',
  '/products?q=laptop&f[ram]=16GB',
  '/category/electronics?category=electronics-tvs&f[resolution]=4K%20Ultra%20HD',
]);
/** The width the rail becomes a sidebar (Tailwind's lg). */
const RAIL_SIDEBAR_FROM = 1024;
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

  // Readable content pushed past the viewport edge and hidden by a clip,
  // which the check above deliberately ignores. See the header.
  const clippedText = [];
  document.querySelectorAll('*').forEach((el) => {
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.right <= window.innerWidth + 1) return;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return;
      if (cs.transform !== 'none') return;
    }
    clippedText.push({ tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 40), right: Math.round(r.right) });
  });

  // Panel pages: text cut with no way to read the rest, and text spilling out
  // of the box around it. See the header.
  const cut = [];
  const spill = [];
  document.querySelectorAll('body *').forEach((el) => {
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    // Screen-reader-only text is clipped on purpose.
    if (r.width <= 1 && r.height <= 1) return;
    const text = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 50);
    const readable = el.getAttribute('title') || el.closest('[title]')?.getAttribute('title') || el.getAttribute('aria-label');
    const ellipsis = cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1;
    const clamp = cs.webkitLineClamp;
    const clamped = clamp && clamp !== 'none' && el.scrollHeight > el.clientHeight + 1;
    if ((ellipsis || clamped) && !readable) cut.push({ tag: el.tagName.toLowerCase(), text });

    // A form control's own value is laid out inside the control, not as text.
    if (['TEXTAREA', 'SELECT', 'OPTION', 'INPUT'].includes(el.tagName)) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const tr = range.getBoundingClientRect();
    if (tr.width === 0 || tr.height === 0) return;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') break;
      const bordered = parseFloat(ps.borderLeftWidth) > 0 && parseFloat(ps.borderRightWidth) > 0;
      const filled = ps.backgroundColor !== 'rgba(0, 0, 0, 0)' && ps.backgroundColor !== 'transparent' && parseFloat(ps.borderTopLeftRadius) > 0;
      if (!bordered && !filled && ps.overflowX === 'visible') continue;
      const pr = p.getBoundingClientRect();
      if (tr.right > pr.right + 1 || tr.left < pr.left - 1) {
        spill.push({ tag: el.tagName.toLowerCase(), text, by: Math.round(Math.max(tr.right - pr.right, pr.left - tr.left)) });
      }
      break;
    }
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
    clippedTextCount: clippedText.length,
    clippedText: clippedText.slice(0, 5),
    searchBoxPx: Math.round(visibleWidth(input)),
    truncatedNodes: truncated,
    cutCount: cut.length,
    cut: cut.slice(0, 6),
    spillCount: spill.length,
    spill: spill.slice(0, 6),
    navScrollableBy: nav ? Math.round(nav.scrollWidth - nav.clientWidth) : 0,
    scrollableCount: [...document.querySelectorAll('main *')].filter((el) => {
      const ov = getComputedStyle(el).overflowX;
      return (ov === 'auto' || ov === 'scroll') && el.scrollWidth > el.clientWidth + 1;
    }).length,
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

const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
};

/**
 * A signed-in shopper with one item in the cart, or null with the reason.
 * Only automatic against localhost; see the header.
 */
async function openSession() {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE);
  if (!local && !PHONE) return { session: null, why: 'not localhost; pass --phone to sign in' };
  // A fresh number each run on localhost, so cooldowns and carts never collide.
  const phone = PHONE ?? `9${String(Date.now()).slice(-9)}`;
  const otp = await api('/api/auth/request-otp', { method: 'POST', body: { phone } });
  const code = otp.data?.devOtp;
  if (!code) return { session: null, why: `no devOtp for ${phone}: ${otp.error?.code ?? 'unknown'}` };
  const verified = await api('/api/auth/verify-otp', { method: 'POST', body: { phone, code } });
  const token = verified.data?.accessToken;
  if (!token) return { session: null, why: `verify-otp failed: ${verified.error?.code ?? 'unknown'}` };
  const list = await api('/api/products?limit=1');
  const slug = list.data?.items?.[0]?.slug;
  if (!slug) return { session: null, why: 'no product to add to the cart' };
  const product = await api(`/api/products/${slug}`);
  const variantId = product.data?.variants?.[0]?.id;
  const added = variantId && (await api('/api/cart/items', { method: 'POST', body: { variantId, quantity: 1 }, token }));
  if (!added?.success) return { session: null, why: `could not add to cart: ${added?.error?.code ?? 'no variant'}` };
  return { session: { token, user: verified.data.user, slug }, why: null };
}

/** The demo seller, signed in. Only automatic against localhost. */
async function openSellerSession() {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE);
  if (!local && !SELLER_PHONE) return { session: null, why: 'not localhost; pass --seller-phone to sign in' };
  const phone = SELLER_PHONE ?? DEMO_SELLER_PHONE;
  const otp = await api('/api/auth/request-otp', { method: 'POST', body: { phone } });
  const code = otp.data?.devOtp;
  if (!code) return { session: null, why: `no devOtp for ${phone}: ${otp.error?.code ?? 'unknown'}` };
  const verified = await api('/api/auth/verify-otp', { method: 'POST', body: { phone, code } });
  const token = verified.data?.accessToken;
  if (!token) return { session: null, why: `verify-otp failed: ${verified.error?.code ?? 'unknown'}` };
  return { session: { token, user: verified.data.user }, why: null };
}

/** The admin, signed in. Only automatic against localhost. */
async function openAdminSession() {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE);
  if (!local && !ADMIN_PHONE) return { session: null, why: 'not localhost; pass --admin-phone to sign in' };
  const phone = ADMIN_PHONE ?? DEMO_ADMIN_PHONE;
  const otp = await api('/api/auth/request-otp', { method: 'POST', body: { phone } });
  const code = otp.data?.devOtp;
  if (!code) return { session: null, why: `no devOtp for ${phone}: ${otp.error?.code ?? 'unknown'}` };
  const verified = await api('/api/auth/verify-otp', { method: 'POST', body: { phone, code } });
  const token = verified.data?.accessToken;
  if (!token) return { session: null, why: `verify-otp failed: ${verified.error?.code ?? 'unknown'}` };
  return { session: { token, user: verified.data.user }, why: null };
}

const browser = await launch();
const { session, why } = await openSession();
if (!session) console.log(`cart and checkout skipped: ${why}`);
const { session: sellerSession, why: sellerWhy } = await openSellerSession();
if (!sellerSession) console.log(`seller pages skipped: ${sellerWhy}`);
const { session: adminSession, why: adminWhy } = await openAdminSession();
if (!adminSession) console.log(`admin pages skipped: ${adminWhy}`);

// Pages with an id in them: the seller's first order, product and return.
const sellerPaths = [...SELLER_PAGE_PATHS];
if (sellerSession) {
  const order = (await api('/api/seller/orders?pageSize=5', { token: sellerSession.token })).data?.items?.[0];
  const product = (await api('/api/seller/products?pageSize=5', { token: sellerSession.token })).data?.items?.[0];
  const ret = (await api('/api/seller/returns', { token: sellerSession.token })).data?.[0];
  if (order) {
    sellerPaths.push(`/seller/orders/${order.orderId}`, `/seller/orders/invoice?orderId=${order.orderId}`);
    if (order.lines?.[0]) sellerPaths.push(`/seller/orders/labels?ids=${order.lines[0].id}`);
  }
  if (product) sellerPaths.push(`/seller/products/${product.id}/edit`);
  if (ret) sellerPaths.push(`/seller/returns/${ret.id}`);
}
const SELLER_PAGES = new Set(sellerPaths);
const ADMIN_PAGES = new Set(ADMIN_PAGE_PATHS);
const PANEL_PAGES = new Set([...SELLER_PAGES, ...ADMIN_PAGES, ...SELLER_PUBLIC_PATHS]);

const firstProduct = session?.slug ?? (await api('/api/products?limit=1')).data?.items?.[0]?.slug;
const PAGES = [
  '/', ...RAIL_PAGES, ...(firstProduct ? [`/products/${firstProduct}`] : []), '/cart', '/checkout', '/track',
  ...SELLER_PUBLIC_PATHS, ...SELLER_PAGES, ...ADMIN_PAGES,
].filter((p) => !ONLY || ONLY.some((prefix) => p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) || p.startsWith(`${prefix}?`)));

/** Sidebar from RAIL_SIDEBAR_FROM up; below, the sheet the Filters button opens. */
async function checkRail(page, width) {
  // The rail renders (in the sidebar, hidden or not) once the listing has loaded.
  await page.locator('aside [data-filter-rail] [data-rail-section]').first().waitFor({ state: 'attached', timeout: 15000 });
  if (width >= RAIL_SIDEBAR_FROM) {
    const sections = await page.locator('aside [data-filter-rail] [data-rail-section]').count();
    return { ok: sections > 0, text: `sidebar ${sections}` };
  }
  const button = page.locator('button', { hasText: 'Filters' }).filter({ visible: true }).first();
  if ((await button.count()) === 0) return { ok: false, text: 'no Filters button' };
  await button.click();
  await page.locator('[data-filter-sheet] [data-rail-section]').first().waitFor({ timeout: 5000 });
  const sheet = await page.evaluate(() => {
    const dialog = document.querySelector('[data-filter-sheet] [role="dialog"]');
    const r = dialog.getBoundingClientRect();
    return {
      sections: dialog.querySelectorAll('[data-rail-section]').length,
      fits: r.left >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
      sideways: [...dialog.querySelectorAll('*')].some((el) => {
        const ov = getComputedStyle(el).overflowX;
        return (ov === 'auto' || ov === 'scroll') && el.scrollWidth > el.clientWidth + 1;
      }),
    };
  });
  return { ok: sheet.sections > 0 && sheet.fits && !sheet.sideways, text: `sheet ${sheet.sections}${sheet.fits ? '' : ' OVERFLOWS'}${sheet.sideways ? ' SCROLLS' : ''}` };
}

// One context for everything: the session, when there is one, lives in
// localStorage exactly as the app stores it, and pages are opened from it.
const context = await browser.newContext();
if (session) {
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem('clowe.accessToken', token);
    localStorage.setItem('clowe.user', JSON.stringify(user));
  }, { token: session.token, user: session.user });
}

// The seller and the admin get contexts of their own, so no session leaks
// into another's pages; public seller pages are opened signed out.
async function contextFor(s) {
  const ctx = await browser.newContext();
  if (s) {
    await ctx.addInitScript(({ token, user }) => {
      localStorage.setItem('clowe.accessToken', token);
      localStorage.setItem('clowe.user', JSON.stringify(user));
    }, { token: s.token, user: s.user });
  }
  return ctx;
}
const sellerContext = await contextFor(sellerSession);
const adminContext = await contextFor(adminSession);
const anonymousContext = await contextFor(null);

const rows = [];
let failures = 0;
let skipped = 0;

for (const path of PAGES) {
  const isSellerPage = SELLER_PAGES.has(path);
  const isAdminPage = ADMIN_PAGES.has(path);
  const isPanelPage = PANEL_PAGES.has(path);
  if ((AUTH_PAGES.has(path) && !session) || (isSellerPage && !sellerSession) || (isAdminPage && !adminSession)) {
    skipped += VIEWPORTS.length;
    continue;
  }
  for (const { width, height } of VIEWPORTS) {
    const page = await (
      isSellerPage ? sellerContext : isAdminPage ? adminContext : SELLER_PUBLIC_PATHS.includes(path) ? anonymousContext : context
    ).newPage();
    await page.setViewportSize({ width, height });
    try {
      await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 });
      const overlayed = await openSearchOverlay(page);
      const m = await page.evaluate(measure);

      const overflowBad =
        m.bodyOverflowPx > 0 ||
        m.unclippedCount > 0 ||
        m.clippedTextCount > 0 ||
        (NO_SCROLLER_PAGES.has(path) && m.scrollableCount > 0) ||
        (isPanelPage && (m.cutCount > 0 || m.spillCount > 0));
      const searchBad = m.searchBoxPx > 0 && m.searchBoxPx < MIN_SEARCH_PX;
      // After the page measure: opening the sheet changes the page.
      // The search overlay opened above would cover the Filters button: start clean.
      if (RAIL_PAGES.has(path) && overlayed) await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
      const rail = RAIL_PAGES.has(path) ? await checkRail(page, width) : null;
      const railBad = rail !== null && !rail.ok;
      if (overflowBad || searchBad || railBad) failures += 1;

      rows.push({
        page: path,
        w: width,
        overflow: m.bodyOverflowPx,
        unclipped: m.unclippedCount,
        clipped: m.clippedTextCount,
        search: m.searchBoxPx + (overlayed ? ' (overlay)' : ''),
        navScroll: m.navScrollableBy,
        scrollers: m.scrollableCount,
        trunc: m.truncatedNodes,
        cut: isPanelPage ? m.cutCount : '',
        spill: isPanelPage ? m.spillCount : '',
        rail: rail?.text ?? '',
        ok: overflowBad || searchBad || railBad ? 'FAIL' : 'ok',
      });
      if (m.unclippedCount > 0) {
        console.error(`\n${path} @${width} — elements overflowing the viewport:`);
        for (const o of m.unclipped) console.error(`   <${o.tag}> ${o.width}px  ${o.cls}`);
      }
      if (isPanelPage && m.cutCount > 0) {
        console.error(`\n${path} @${width} — text cut short with no way to read it:`);
        for (const o of m.cut) console.error(`   <${o.tag}> "${o.text}"`);
      }
      if (isPanelPage && m.spillCount > 0) {
        console.error(`\n${path} @${width} — text spilling out of its box:`);
        for (const o of m.spill) console.error(`   <${o.tag}> by ${o.by}px  "${o.text}"`);
      }
      if (m.clippedTextCount > 0) {
        console.error(`\n${path} @${width} — readable content cut off at the right edge:`);
        for (const o of m.clippedText) console.error(`   <${o.tag}> right=${o.right}px  "${o.text}"`);
      }
    } catch (err) {
      failures += 1;
      rows.push({ page: path, w: width, overflow: '-', unclipped: '-', clipped: '-', search: '-',
                  navScroll: '-', trunc: '-', ok: `ERROR ${err.message.slice(0, 40)}` });
    } finally {
      await page.close();
    }
  }
}

// Leave the throwaway shopper with an empty cart.
if (session) await api('/api/cart', { method: 'DELETE', token: session.token }).catch(() => {});
await browser.close();
console.table(rows);
console.log(
  (failures === 0
    ? `\nAll ${rows.length} checks passed (body overflow 0, nothing clipped, search >= ${MIN_SEARCH_PX}px).`
    : `\n${failures} of ${rows.length} checks FAILED.`) +
    (skipped ? ` ${skipped} skipped (no session).` : ''),
);
process.exit(failures === 0 ? 0 : 1);
