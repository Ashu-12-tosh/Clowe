#!/usr/bin/env node
/**
 * Voice search probe — what each browser's recogniser actually does, and what
 * the site shows the shopper as a result. Measures, rather than infers.
 *
 *   node scripts/voice-probe.mjs [baseUrl] [--only=brave,chrome,edge] [--runs=N] [--silence] [--json]
 *
 * baseUrl defaults to http://localhost:4300; pass https://cloweshop.com to
 * probe production. Needs `playwright` (a devDependency) and whichever of
 * Brave, Chrome and Edge are installed — any that are missing are skipped.
 * Brave is found in its usual install location, or set BRAVE_PATH.
 *
 * Two measurements per browser per run:
 *
 *   raw    A blank page served from here, calling the Web Speech API directly
 *          and logging every event. What the browser does with no Clowe code
 *          involved — this is how Brave was shown to report `network` on a
 *          page that has nothing of ours on it.
 *
 *   site   The site, with SpeechRecognition wrapped before it loads so every
 *          event the app's handlers received is logged, then the mic clicked
 *          the way a shopper would. Records the message shown and whether the
 *          app went to results.
 *
 * The results request never leaves the browser. It is intercepted, recorded,
 * and held unanswered, so the app has demonstrably tried to search while the
 * server never sees it. Without this, every run is a real search with whatever
 * the recogniser made of the test tone, written to the search log that feeds
 * type-ahead suggestions — and in production a phrase becomes a suggestion
 * after three logged searches. Holding the request also keeps the page in
 * place, so the message is read off the same header that showed it.
 *
 * What it asserts (exit 1 if any fails):
 *
 *   The mic is hidden in Brave, and shown in Chrome and Edge. Brave's
 *   recogniser can never work — the service behind the API is removed and it
 *   reports `network` instead — while hiding it anywhere else would take
 *   voice search away from people it works for.
 *
 *   No run ends in silence. Once the mic is clicked, the shopper either sees
 *   a message or lands on results. Chrome can end a run with no result and no
 *   error, and that used to show nothing at all.
 *
 *   A run that reached results does not also say voice search stopped
 *   responding. The watchdog can fire after interim results arrived; the
 *   transcript is searched, so from the shopper's side it worked.
 *
 *   Nothing is still listening after WAIT_MS. That is longer than the app's
 *   own 10s watchdog, so it would mean the watchdog failed.
 *
 *   With --silence: saying nothing is reported as not having been caught,
 *   never as voice search having stopped responding. The microphone gets a
 *   silent recording instead of the test tone, so every run is a shopper who
 *   said nothing, and the browser's own no-speech has to arrive before the
 *   app's watchdog does.
 *
 * Browsers run headed: windows open and close on their own. Headless Chrome's
 * recogniser accepts start() and then never calls back at all, so it measures
 * the wrong thing. The microphone is Chromium's fake device — a synthetic
 * tone, not speech — and recognisers react to it differently from run to run:
 * Edge sometimes transcribes it as words, Chrome sometimes hears "speech" it
 * cannot transcribe. That is useful, because it exercises more endings than
 * real silence would. It is also why --runs exists: one run is one sample.
 *
 * Exits 2 if Playwright or every browser is missing.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const BASE = (argv.find((a) => !a.startsWith('--')) ?? 'http://localhost:4300').replace(/\/$/, '');
const ONLY = flag('only')?.split(',');
const RUNS = Math.max(1, Number(flag('runs') ?? 1));
const JSON_OUT = argv.includes('--json');
const SILENCE = argv.includes('--silence');

/** Longer than the app's 10s watchdog, so whichever fires first is visible. */
const WAIT_MS = 15000;
/** Long enough for the mount effect's async Brave check to settle. */
const MIC_SETTLE_MS = 5000;
/**
 * The watchdog's wording (`timeout` in packages/shared/src/voiceSearch.ts).
 * Matched loosely on purpose, and the unit test there pins the same phrase, so
 * rewording it breaks that test before it can quietly blind this one.
 */
const TIMEOUT_WORDING = /stopped responding/i;

const { chromium } = await import('playwright').catch(() => {
  console.error('playwright is not installed. Run:  npm i -D playwright');
  process.exit(2);
});

function findBrave() {
  if (process.env.BRAVE_PATH) return process.env.BRAVE_PATH;
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const candidates = {
    win32: [
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ],
    darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    linux: ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave', '/opt/brave.com/brave/brave'],
  }[process.platform] ?? [];
  return candidates.find((p) => fs.existsSync(p));
}

const BROWSERS = [
  { name: 'brave', isBrave: true, launch: () => { const p = findBrave(); return p ? { executablePath: p } : null; } },
  { name: 'chrome', isBrave: false, launch: () => ({ channel: 'chrome' }) },
  { name: 'edge', isBrave: false, launch: () => ({ channel: 'msedge' }) },
].filter((b) => !ONLY || ONLY.includes(b.name));

/**
 * Thirty seconds of 16-bit mono silence, for --silence. Chromium plays it as
 * the microphone in place of its test tone.
 */
function writeSilentWav() {
  const rate = 16000;
  const bytes = 30 * rate * 2;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);
  const file = path.join(os.tmpdir(), `clowe-voice-probe-silence-${process.pid}.wav`);
  fs.writeFileSync(file, buf);
  return file;
}

const LAUNCH_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
const silentWav = SILENCE ? writeSilentWav() : null;
if (silentWav) LAUNCH_ARGS.push(`--use-file-for-fake-audio-capture=${silentWav}`);

// --- raw: the Web Speech API on a page with nothing of ours on it ------------

const HARNESS = `<!doctype html><meta charset="utf-8"><title>voice probe</title>
<script>
  const log = [];
  const t0 = performance.now();
  const rec = (name, extra) => log.push(Object.assign({ name, t: Math.round(performance.now() - t0) }, extra));
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  window.__probe = { hasRecognizer: !!Ctor, log };
  if (Ctor) {
    const r = new Ctor();
    r.lang = 'en-IN';
    r.interimResults = true;
    for (const ev of ['start','audiostart','soundstart','speechstart','speechend','soundend','audioend','nomatch','end']) {
      r['on' + ev] = () => rec(ev);
    }
    r.onresult = (e) => rec('result', { transcript: e.results[0] && e.results[0][0] ? e.results[0][0].transcript : null });
    r.onerror = (e) => rec('error', { error: e.error });
    try { r.start(); } catch (e) { rec('start threw', { error: String(e) }); }
  }
</script>`;

const harness = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HARNESS);
});
await new Promise((resolve) => harness.listen(0, '127.0.0.1', resolve));
const HARNESS_URL = `http://127.0.0.1:${harness.address().port}/`;

async function probeRaw(context) {
  const page = await context.newPage();
  try {
    await page.goto(HARNESS_URL);
    const started = Date.now();
    while (Date.now() - started < WAIT_MS) {
      if (await page.evaluate(() => window.__probe.log.some((e) => e.name === 'end'))) break;
      await page.waitForTimeout(200);
    }
    return await page.evaluate(() => window.__probe);
  } finally {
    await page.close();
  }
}

// --- site: the real page, every recogniser event the app received logged ----

/** Runs in the page before any of its scripts. */
function wrapRecognizer() {
  const Orig = window.webkitSpeechRecognition || window.SpeechRecognition;
  if (!Orig) return;
  const t0 = performance.now();
  window.__events = [];
  const push = (name, extra) => window.__events.push(Object.assign({ name, t: Math.round(performance.now() - t0) }, extra));
  class Wrapped extends Orig {
    constructor() {
      super();
      for (const ev of ['start', 'audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend', 'nomatch', 'end']) {
        this.addEventListener(ev, () => push(ev));
      }
      this.addEventListener('result', (e) => push('result', { transcript: e.results[0] && e.results[0][0] ? e.results[0][0].transcript : null }));
      this.addEventListener('error', (e) => push('error', { error: e.error }));
    }
    start() { push('start()'); return super.start(); }
    stop() { push('stop()'); return super.stop(); }
  }
  window.webkitSpeechRecognition = Wrapped;
  window.SpeechRecognition = Wrapped;
}

async function probeSite(context) {
  const page = await context.newPage();
  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // The header has rendered once the search field is up; then give the
    // mount effect time to decide whether to show the mic at all.
    await page.locator('header input[role="combobox"]').first().waitFor({ state: 'visible', timeout: 20000 });
    const mic = page.locator('header button[aria-label="Search by voice"]').first();
    let micVisible = false;
    const settleBy = Date.now() + MIC_SETTLE_MS;
    while (Date.now() < settleBy) {
      if (await mic.isVisible().catch(() => false)) { micVisible = true; break; }
      await page.waitForTimeout(200);
    }
    if (!micVisible) return { micVisible };

    const searched = [];
    await page.route(
      (url) => url.pathname === '/products' && url.searchParams.has('q'),
      // Recorded and never answered: see the header comment.
      (route) => { searched.push(new URL(route.request().url()).searchParams.get('q')); },
    );
    const clickedAt = Date.now();
    await mic.click();
    const read = () => page.evaluate(() => ({
      message: document.querySelector('header p[role="status"]')?.textContent?.trim() || null,
      listening: !!document.querySelector('header button[aria-label="Stop listening"]'),
      ended: (window.__events || []).some((e) => e.name === 'end'),
    }));
    let state = await read();
    let endedAt = 0;
    while (Date.now() - clickedAt < WAIT_MS) {
      state = await read();
      if (state.message || searched.length) break;
      // The recogniser has ended and nothing has appeared: allow a beat for
      // React to render whatever it is going to, then call it.
      if (state.ended && !state.listening) {
        endedAt ||= Date.now();
        if (Date.now() - endedAt > 1500) break;
      }
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(500);
    state = await read();
    const events = await page.evaluate(() => window.__events || []);
    const outcome =
      searched.length ? 'results'
      : state.message ? 'message'
      : state.listening ? 'stuck'
      : 'silent';
    return { micVisible, outcome, message: state.message, searched: searched[0] ?? null, events };
  } finally {
    await page.close();
  }
}

function summarise(events) {
  const err = events.find((e) => e.name === 'error');
  if (err) return `error:${err.error} @${err.t}ms`;
  const results = events.filter((e) => e.name === 'result');
  const end = events.find((e) => e.name === 'end');
  if (results.length) return `result "${results.at(-1).transcript}"`;
  if (end) return `end, no result @${end.t}ms`;
  return 'never ended';
}

// --- run --------------------------------------------------------------------

const rows = [];
const details = [];
let failures = 0;
let launched = 0;

for (const b of BROWSERS) {
  const opts = b.launch();
  if (!opts) {
    rows.push({ browser: b.name, run: '-', raw: '-', mic: '-', outcome: 'not installed', message: '', ok: 'skip' });
    continue;
  }
  for (let run = 1; run <= RUNS; run++) {
    let browser;
    try {
      browser = await chromium.launch({
        ...opts,
        headless: false,
        args: LAUNCH_ARGS,
      });
    } catch (err) {
      rows.push({ browser: b.name, run, raw: '-', mic: '-', outcome: 'not installed', message: String(err.message).split('\n')[0].slice(0, 60), ok: 'skip' });
      break;
    }
    launched += 1;
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.grantPermissions(['microphone'], { origin: new URL(HARNESS_URL).origin });
      await context.grantPermissions(['microphone'], { origin: new URL(BASE).origin });
      await context.addInitScript(wrapRecognizer);

      const raw = await probeRaw(context);
      const site = await probeSite(context);

      const problems = [];
      if (b.isBrave && site.micVisible) problems.push('mic shown in Brave');
      if (!b.isBrave && !site.micVisible) problems.push(`mic hidden in ${b.name}`);
      if (site.outcome === 'silent') problems.push('ended in silence');
      if (site.outcome === 'stuck') problems.push(`still listening after ${WAIT_MS}ms`);
      if (site.outcome === 'results' && TIMEOUT_WORDING.test(site.message ?? '')) {
        problems.push('said it stopped responding over results');
      }
      if (SILENCE && site.outcome === 'message' && TIMEOUT_WORDING.test(site.message ?? '')) {
        problems.push('silence reported as stopped responding');
      }
      failures += problems.length ? 1 : 0;

      rows.push({
        browser: `${b.name} ${browser.version()}`,
        run,
        raw: raw.hasRecognizer ? summarise(raw.log) : 'no recogniser',
        mic: site.micVisible ? 'shown' : 'hidden',
        outcome: site.outcome ?? '-',
        message: site.message ?? '',
        ok: problems.length ? `FAIL: ${problems.join('; ')}` : 'ok',
      });
      details.push({ browser: b.name, version: browser.version(), run, raw, site });
    } catch (err) {
      failures += 1;
      rows.push({ browser: b.name, run, raw: '-', mic: '-', outcome: '-', message: '', ok: `ERROR ${String(err.message).split('\n')[0].slice(0, 60)}` });
    } finally {
      await browser.close();
    }
  }
}

harness.close();
if (silentWav) fs.rmSync(silentWav, { force: true });

if (JSON_OUT) console.log(JSON.stringify(details, null, 2));
console.log(`site: ${BASE}${SILENCE ? '  (microphone: silence)' : ''}`);
console.table(rows);

if (launched === 0) {
  console.error('\nNo browser could be launched. Install Brave, Chrome or Edge, or set BRAVE_PATH.');
  process.exit(2);
}
const checked = rows.filter((r) => r.ok !== 'skip').length;
console.log(
  failures === 0
    ? `\nAll ${checked} runs passed (mic hidden in Brave only, no silent, stuck or contradictory endings).`
    : `\n${failures} of ${checked} runs FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
