/**
 * End-to-end exercise of the try-on pipeline over real HTTP, against whatever
 * provider is configured. Covers the happy path and every guard on the route.
 *
 *   npm run dev:api                      # in another terminal
 *   npm run tryon:e2e --workspace=@clowe/api
 *
 * Creates a throwaway account (a fresh phone number each run) and performs one
 * try-on. Against the mock provider that is free; against FASHN it spends one
 * credit. Run it from the repo root so the demo image path resolves.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const API = process.env.API_URL ?? 'http://localhost:4000';
// Fresh number per run: the OTP endpoint enforces a 45s per-phone cooldown.
const PHONE = `9${String(Date.now()).slice(-9)}`;
let pass = 0;
let fail = 0;

function ok(label, detail = '') {
  pass++;
  console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
}
function bad(label, detail) {
  fail++;
  console.log(`  FAIL  ${label} — ${detail}`);
}
function skip(label, detail) {
  console.log(`  skip  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function call(pathname, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function login() {
  const otp = await call('/api/auth/request-otp', { method: 'POST', body: { phone: PHONE } });
  const code = otp.json?.data?.devOtp;
  if (!code) throw new Error(`no dev OTP returned: ${JSON.stringify(otp.json)}`);
  const verify = await call('/api/auth/verify-otp', {
    method: 'POST',
    body: { phone: PHONE, code, name: 'TryOn Tester' },
  });
  const token = verify.json?.data?.accessToken;
  if (!token) throw new Error(`login failed: ${JSON.stringify(verify.json)}`);
  return token;
}

/**
 * Newest product in a category, with its detail payload. Filtering server-side
 * keeps this to two requests — walking the whole catalog and fetching every
 * detail trips the API's own rate limiter, which is exactly what it is for.
 */
async function productInCategory(slug, { sort = 'price_desc' } = {}) {
  const list = await call(`/api/products?category=${slug}&limit=1&sort=${sort}`);
  const item = list.json?.data?.items?.[0];
  if (!item) return null;
  const detail = await call(`/api/products/${item.slug}`);
  const d = detail.json?.data;
  return d ? { item, detail: d } : null;
}

/** First try-on-eligible product across the given categories. */
async function findEligible(slugs) {
  for (const slug of slugs) {
    const found = await productInCategory(slug);
    if (found?.detail.tryOnEligible) return found;
  }
  return null;
}

async function main() {
  console.log('Try-On pipeline — end to end over HTTP\n');

  console.log('1. Auth + quota');
  const token = await login();
  ok('logged in');
  const quota = await call('/api/tryon/quota', { token });
  const provider = quota.json?.data?.provider;
  if (quota.json?.success) {
    const q = quota.json.data;
    ok('quota endpoint', `provider=${q.provider}, ${q.usedToday}/${q.dailyLimit} used today`);
  } else bad('quota endpoint', JSON.stringify(quota.json));

  console.log('\n2. Auth is required');
  const noAuth = await call('/api/tryon/quota');
  if (noAuth.status === 401) ok('anonymous request rejected', 'HTTP 401');
  else bad('anonymous request', `expected 401, got ${noAuth.status}`);

  console.log('\n3. Photo upload');
  const demoDir = path.resolve('apps/api/uploads/demo');
  const firstJpg = (await fs.readdir(demoDir)).find((f) => f.endsWith('.jpg'));
  const bytes = await fs.readFile(path.join(demoDir, firstJpg));
  const form = new FormData();
  form.append('images', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg');
  const upRes = await fetch(`${API}/api/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const photoUrl = (await upRes.json())?.data?.urls?.[0];
  if (photoUrl) ok('photo uploaded', photoUrl.replace(API, ''));
  else return bad('photo upload', 'no url returned');

  console.log('\n4. Saved photo round-trip');
  const saved = await call('/api/tryon/photo', { method: 'POST', token, body: { photoUrl } });
  if (saved.json?.data?.savedPhotoUrl === photoUrl) ok('photo saved to the account');
  else bad('save photo', JSON.stringify(saved.json));
  const quota2 = await call('/api/tryon/quota', { token });
  if (quota2.json?.data?.savedPhotoUrl === photoUrl) ok('saved photo returned by quota');
  else bad('saved photo not returned', JSON.stringify(quota2.json?.data));

  console.log('\n5. Eligibility guards');
  // Categories the AI physically cannot try on must be refused before any
  // provider call, so no credit is ever spent on them.
  for (const [label, slug] of [
    ['sunglasses', 'fashion-sunglasses'],
    ['footwear', 'fashion-footwear'],
    ['jewellery', 'fashion-jewellery'],
    ['watches', 'fashion-watches'],
    ['bags', 'fashion-bags'],
    ['caps', 'fashion-caps'],
    ['accessories', 'fashion-accessories'],
    ['electronics', 'electronics'],
    ['innerwear (sensitive)', 'fashion-innerwear'],
  ]) {
    const found = await productInCategory(slug);
    if (!found) {
      skip(`${label} has no product`);
      continue;
    }
    if (found.detail.tryOnEligible) {
      bad(`${label} is still marked eligible`, found.detail.title);
      continue;
    }
    const r = await call('/api/tryon', {
      method: 'POST',
      token,
      body: { productId: found.item.id, photoUrl },
    });
    if (r.json?.error?.code === 'TRYON_NOT_ELIGIBLE') {
      ok(`${label} refused`, found.detail.title.slice(0, 34));
    } else bad(`${label} should be refused`, JSON.stringify(r.json).slice(0, 140));
  }

  const missing = await call('/api/tryon', {
    method: 'POST',
    token,
    body: { productId: 'does-not-exist', photoUrl },
  });
  if (missing.json?.error?.code === 'NOT_FOUND') ok('unknown product refused', 'NOT_FOUND');
  else bad('unknown product', JSON.stringify(missing.json).slice(0, 140));

  const badBody = await call('/api/tryon', { method: 'POST', token, body: { productId: 'x' } });
  if (!badBody.json?.success) ok('missing photoUrl refused', badBody.json?.error?.code ?? '4xx');
  else bad('missing photoUrl accepted', JSON.stringify(badBody.json).slice(0, 120));

  console.log('\n6. A real run');
  const eligible = await findEligible([
    'fashion-winter',
    'fashion-men',
    'fashion-women',
    'fashion-ethnic',
    'fashion-kids',
  ]);
  if (!eligible) {
    bad('no eligible product', 'nothing in the catalog passes every gate');
  } else {
    ok('eligible product', `${eligible.detail.title} (${eligible.detail.category.name})`);
    const started = Date.now();
    const run = await call('/api/tryon', {
      method: 'POST',
      token,
      body: {
        productId: eligible.item.id,
        photoUrl,
        variantSize: 'M',
        variantColor: 'Black',
      },
    });
    const d = run.json?.data;
    if (!run.json?.success) {
      bad('try-on request', JSON.stringify(run.json).slice(0, 200));
    } else if (d.status === 'SUCCESS') {
      ok('generated', `${Date.now() - started} ms via ${d.provider}`);
      ok('result url', d.resultImageUrl?.replace(API, ''));
      ok('quota decremented', `${d.remainingToday} runs left today`);
      ok('cost logged', `${d.costPaise} paise`);
      const img = await fetch(d.resultImageUrl);
      if (img.ok) ok('result is served', `HTTP ${img.status}, ${img.headers.get('content-type')}`);
      else bad('result not served', `HTTP ${img.status}`);
    } else {
      bad('generation failed', d.errorMessage ?? 'no message');
    }
  }

  console.log('\n7. History + feedback');
  const history = await call('/api/tryon/history', { token });
  const rows = history.json?.data ?? [];
  if (rows.length > 0) ok('history returns the run', `${rows.length} row(s)`);
  else bad('history empty', 'expected the run just made');
  const success = rows.find((r) => r.status === 'SUCCESS');
  if (success) {
    ok('variant recorded', `${success.variantSize ?? '-'} / ${success.variantColor ?? '-'}`);
    const fb = await call(`/api/tryon/${success.id}/feedback`, {
      method: 'POST',
      token,
      body: { feedback: 'UP' },
    });
    if (fb.json?.data?.feedback === 'UP') ok('feedback saved');
    else bad('feedback', JSON.stringify(fb.json).slice(0, 140));
    const cleared = await call(`/api/tryon/${success.id}/feedback`, {
      method: 'POST',
      token,
      body: { feedback: null },
    });
    if (cleared.json?.data?.feedback === null) ok('feedback cleared');
    else bad('clear feedback', JSON.stringify(cleared.json).slice(0, 140));
  }

  const foreign = await call('/api/tryon/someone-elses-id/feedback', {
    method: 'POST',
    token,
    body: { feedback: 'UP' },
  });
  if (foreign.json?.error?.code === 'NOT_FOUND') ok("can't rate another user's run", 'NOT_FOUND');
  else bad('feedback ownership', JSON.stringify(foreign.json).slice(0, 140));

  console.log('\n8. Photo deletion');
  const del = await call('/api/tryon/photo', { method: 'DELETE', token });
  if (del.json?.data?.savedPhotoUrl === null) ok('saved photo cleared');
  else bad('delete photo', JSON.stringify(del.json).slice(0, 140));

  console.log(`\n${pass} passed, ${fail} failed  (provider: ${provider})`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
