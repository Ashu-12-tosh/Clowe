#!/usr/bin/env node
/**
 * Voice search probe — what each browser's recogniser actually does, and what
 * the site shows the shopper as a result. Measures, rather than infers.
 *
 *   node scripts/voice-probe.mjs [baseUrl] [--only=brave,chrome,edge] [--runs=N] [--silence] [--json[=file]]
 *   node scripts/voice-probe.mjs --audio=<wav|dir> [--lang=en-IN,en-US] [--alternatives=N]
 *                                [--only=chrome,edge] [--runs=N] [--json[=file]]
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
 * The microphone is never the real one. A plain start() ignores Chromium's
 * fake-device flags and opens the machine's real default microphone:
 * chrome://media-internals shows getUserMedia opening the `fake` input while
 * the recogniser's own capture opens `pcm_low_latency`, and Windows' microphone
 * log shows Chrome, Edge and Brave all opening the real device for it. Earlier
 * versions of this probe called start() that way, so they recorded the room
 * and sent it to Google and Microsoft; the "test tone" transcripts were people
 * talking nearby. So every recogniser here is started with an explicit track
 * instead: getUserMedia on the fake device, resampled to 16 kHz mono, passed
 * to start(track) — the raw page directly, and the site through the wrapped
 * recogniser, whose start() swaps the app's plain call for one with the track.
 * Two guards keep it that way. A browser older than Chromium 135 ignores the
 * track argument (MDN compat data: api.SpeechRecognition.start.audioTrack)
 * and would fall back to the real microphone, so recognition is not run there
 * at all. And the track is refused unless the device it came from is the fake
 * one, by its label, in case the fake-device flags ever stop applying.
 *
 * What the fake microphone plays: Chromium's beep by default, a silent
 * recording with --silence, a recording of speech with --audio.
 *
 * Browsers run headed: windows open and close on their own. Headless Chrome's
 * recogniser accepts start() and then never calls back at all, so it measures
 * the wrong thing. One run is one sample, which is why --runs exists.
 *
 * --json prints every run's detail before the table; --json=<file> writes it
 * to that file instead.
 *
 * Transcripts of recorded speech (--audio): what each recogniser makes of
 * known words, for measuring accuracy rather than endings. No site is
 * involved — nothing is searched, so nothing can reach a search log — and the
 * baseUrl argument is ignored. The assertions above do not apply.
 *
 *   --audio=<path>      A WAV file, or a directory whose *.wav files are all
 *                       played (not recursive). 16-bit PCM at any sample rate
 *                       and channel count; Chromium resamples. Each file is
 *                       copied with 0.5s of silence before and 2s after, so
 *                       the recogniser hears a clean start and ends on its
 *                       own, and played once (the `%noloop` suffix on the
 *                       fake-capture path: without it the file loops).
 *   --lang=a,b          Recogniser languages to try, each its own session.
 *                       Default en-IN, as the app uses.
 *   --alternatives=N    maxAlternatives (default 1). Every alternative is
 *                       recorded with its confidence, as the recogniser gave
 *                       them; the app itself only ever reads the first.
 *   --runs=N            Sessions per file per language.
 *   --only=...          Browsers; defaults to chrome alone in this mode.
 *
 * A file `name.txt` beside `name.wav` is taken as what was said, and the
 * table then shows whether the top transcript matches it (case, punctuation,
 * "15k" / "15,000" / "15000" ignored). One browser launch per file: the
 * fake-capture file is fixed at launch, but every new capture stream plays it
 * from the start, so each language and run gets a fresh session over the same
 * recording. Interim results are on, as in the app; the transcript reported is
 * the last result received, final if there was one.
 *
 * The recording reaches the recogniser the same way as everything else here,
 * as an explicit 16 kHz track. The resampling is for Edge: given the fake
 * device's own 48 kHz track its recogniser returns an empty or nonsense
 * transcript ("Samsung phone under 15000" came back as "Harshin Fernandez of
 * Truth."), and at 16 kHz it transcribes correctly. Chrome is right either way.
 *
 * Exits 1 if a run fails to complete; transcripts that do not match are
 * measurements, not failures.
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
const JSON_FILE = flag('json');
const JSON_OUT = argv.includes('--json') || Boolean(JSON_FILE);
const SILENCE = argv.includes('--silence');
const AUDIO = flag('audio');
const LANGS = (flag('lang') ?? 'en-IN').split(',').map((l) => l.trim()).filter(Boolean);
const ALTERNATIVES = Math.max(1, Number(flag('alternatives') ?? 1));
if (AUDIO && SILENCE) {
  console.error('--audio and --silence both choose what the microphone plays; pick one.');
  process.exit(2);
}

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
/** First Chromium whose start() takes a track; older ones open the real mic. */
const MIN_CHROMIUM_FOR_TRACK = 135;

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
].filter((b) => (ONLY ? ONLY.includes(b.name) : !AUDIO || b.name === 'chrome'));

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

const LAUNCH_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  // The 16 kHz AudioContext that feeds the recogniser has to run without a click.
  '--autoplay-policy=no-user-gesture-required',
];

/** True if this browser's start() takes a track; see the header. */
function takesTrack(version) {
  return Number(String(version).split('.')[0]) >= MIN_CHROMIUM_FOR_TRACK;
}
const NO_TRACK = `older than Chromium ${MIN_CHROMIUM_FOR_TRACK}: start() would open the real microphone`;

/**
 * In-page: the fake microphone as a 16 kHz mono track for start(track), or a
 * rejection if what getUserMedia opened is not the fake device. Every page the
 * probe drives gets this, so no recogniser here is ever started without it.
 */
const FAKE_MIC_JS = `
async function __fakeMicTrack() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const mic = stream.getAudioTracks()[0];
  if (!/fake/i.test(mic.label)) {
    mic.stop();
    throw new Error('not the fake device: ' + mic.label);
  }
  const ac = new AudioContext({ sampleRate: 16000 });
  const dest = ac.createMediaStreamDestination();
  dest.channelCount = 1;
  ac.createMediaStreamSource(stream).connect(dest);
  return {
    track: dest.stream.getAudioTracks()[0],
    label: mic.label,
    sampleRate: ac.sampleRate,
    stop() { mic.stop(); ac.close(); },
  };
}`;
const silentWav = SILENCE ? writeSilentWav() : null;
if (silentWav) LAUNCH_ARGS.push(`--use-file-for-fake-audio-capture=${silentWav}`);

// --- raw: the Web Speech API on a page with nothing of ours on it ------------

const HARNESS = `<!doctype html><meta charset="utf-8"><title>voice probe</title>
<script>${FAKE_MIC_JS}
  const log = [];
  const t0 = performance.now();
  const rec = (name, extra) => log.push(Object.assign({ name, t: Math.round(performance.now() - t0) }, extra));
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  window.__probe = { hasRecognizer: !!Ctor, log };
  (async () => {
    if (!Ctor) return rec('end');
    let mic;
    try {
      mic = await __fakeMicTrack();
    } catch (e) {
      rec('error', { error: 'probe: ' + e.message });
      return rec('end');
    }
    const r = new Ctor();
    r.lang = 'en-IN';
    r.interimResults = true;
    for (const ev of ['start','audiostart','soundstart','speechstart','speechend','soundend','audioend','nomatch','end']) {
      r['on' + ev] = () => rec(ev);
    }
    r.addEventListener('end', () => mic.stop());
    // Every segment, as the app reads them.
    r.onresult = (e) => rec('result', { transcript: Array.from(e.results, (res) => (res[0] ? res[0].transcript : '')).join('').trim() });
    r.onerror = (e) => rec('error', { error: e.error });
    try { r.start(mic.track); } catch (e) { rec('start threw', { error: String(e) }); rec('end'); }
  })();
</script>`;

/**
 * --audio: the fake microphone's track handed to the recogniser explicitly
 * (see the header for why), every alternative of every result logged.
 */
const AUDIO_HARNESS = `<!doctype html><meta charset="utf-8"><title>voice probe: audio</title>
<script>${FAKE_MIC_JS}
  const params = new URLSearchParams(location.search);
  const log = [];
  const t0 = performance.now();
  const rec = (name, extra) => log.push(Object.assign({ name, t: Math.round(performance.now() - t0) }, extra));
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  window.__probe = { hasRecognizer: !!Ctor, log };
  (async () => {
    if (!Ctor) return rec('end');
    let mic;
    try {
      mic = await __fakeMicTrack();
      rec('mic', { label: mic.label, sampleRate: mic.sampleRate });
    } catch (e) {
      rec('error', { error: 'probe: ' + e.message });
      return rec('end');
    }
    const r = new Ctor();
    r.lang = params.get('lang');
    r.interimResults = true;
    r.maxAlternatives = Number(params.get('alternatives'));
    for (const ev of ['start','audiostart','soundstart','speechstart','speechend','soundend','audioend','nomatch','end']) {
      r.addEventListener(ev, () => rec(ev));
    }
    r.addEventListener('end', () => mic.stop());
    r.onresult = (e) => rec('result', {
      results: Array.from(e.results, (res) => ({
        isFinal: res.isFinal,
        alternatives: Array.from(res, (a) => ({ transcript: a.transcript, confidence: a.confidence })),
      })),
    });
    r.onerror = (e) => rec('error', { error: e.error });
    try { r.start(mic.track); } catch (e) { rec('start threw', { error: String(e) }); rec('end'); }
  })();
</script>`;

const harness = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url.startsWith('/audio') ? AUDIO_HARNESS : HARNESS);
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
      this.addEventListener('result', (e) => push('result', { transcript: Array.from(e.results, (res) => (res[0] ? res[0].transcript : '')).join('').trim() }));
      this.addEventListener('error', (e) => push('error', { error: e.error }));
    }
    // The app calls start() with no track, which would open the real
    // microphone. Never pass that through: start with the fake track, or not
    // at all. __fakeMicTrack is injected alongside this function. See the header.
    start() {
      push('start()');
      __fakeMicTrack().then(
        (mic) => {
          this.addEventListener('end', () => mic.stop(), { once: true });
          super.start(mic.track);
        },
        (e) => push('probe-error', { error: e.message }),
      );
    }
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
    const probeError = events.find((e) => e.name === 'probe-error');
    if (probeError) return { micVisible, outcome: 'probe-error', message: probeError.error, events };
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

// --- audio: transcripts of recorded speech ---------------------------------

const PAD_BEFORE_S = 0.5;
const PAD_AFTER_S = 2;

/**
 * The file as 16-bit PCM with silence either side, written to a temp file.
 * Only the fmt and data chunks are kept, so any header Chromium might
 * stumble on (LIST, WAVEFORMATEX extras) is gone.
 */
function padWav(file, index) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let fmt;
  let data;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    }
    if (id === 'data') data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('no fmt or data chunk');
  if (![1, 0xfffe].includes(fmt.format) || fmt.bits !== 16) throw new Error(`need 16-bit PCM, got format ${fmt.format} at ${fmt.bits} bits`);
  const frame = 2 * fmt.channels;
  const pcm = Buffer.concat([
    Buffer.alloc(Math.round(PAD_BEFORE_S * fmt.rate) * frame),
    data.subarray(0, data.length - (data.length % frame)),
    Buffer.alloc(Math.round(PAD_AFTER_S * fmt.rate) * frame),
  ]);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(fmt.channels, 22);
  header.writeUInt32LE(fmt.rate, 24);
  header.writeUInt32LE(fmt.rate * frame, 28);
  header.writeUInt16LE(frame, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  const out = path.join(os.tmpdir(), `clowe-voice-probe-audio-${process.pid}-${index}.wav`);
  fs.writeFileSync(out, Buffer.concat([header, pcm]));
  return { path: out, seconds: pcm.length / frame / fmt.rate };
}

/** Lower-case words, no punctuation, and "15k" / "15,000" both as 15000. */
function normaliseSpoken(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/(\d),(?=\d)/g, '$1')
    .replace(/\b(\d+)\s*k\b/g, (_m, n) => String(Number(n) * 1000))
    .replace(/[^a-z0-9\u0900-\u097f]+/g, ' ')
    .trim();
}

async function probeAudio(context, lang, waitMs) {
  const page = await context.newPage();
  try {
    await page.goto(`${HARNESS_URL}audio?lang=${encodeURIComponent(lang)}&alternatives=${ALTERNATIVES}`);
    const started = Date.now();
    while (Date.now() - started < waitMs) {
      if (await page.evaluate(() => window.__probe.log.some((e) => e.name === 'end'))) break;
      await page.waitForTimeout(200);
    }
    const { hasRecognizer, log } = await page.evaluate(() => window.__probe);
    const last = log.filter((e) => e.name === 'result').at(-1);
    const err = log.find((e) => e.name === 'error' || e.name === 'start threw');
    return {
      hasRecognizer,
      ended: log.some((e) => e.name === 'end'),
      final: Boolean(last?.results[0]?.isFinal),
      // results[0], because that is the one the app reads.
      alternatives: last?.results[0]?.alternatives ?? [],
      // Everything heard, in case the recogniser split the utterance.
      heard: last ? last.results.map((r) => r.alternatives[0]?.transcript ?? '').join('').trim() : '',
      error: err ? err.error : null,
      log,
    };
  } finally {
    await page.close();
  }
}

async function runAudio() {
  const files = fs.statSync(AUDIO).isDirectory()
    ? fs.readdirSync(AUDIO).filter((f) => /\.wav$/i.test(f)).sort().map((f) => path.join(AUDIO, f))
    : [AUDIO];
  if (!files.length) {
    console.error(`No .wav files in ${AUDIO}`);
    process.exit(2);
  }
  const audioRows = [];
  const audioDetails = [];
  const temps = [];
  let audioFailures = 0;
  let audioLaunched = 0;
  const failRow = (browser, file, why) => ({ browser, file, lang: '-', run: '-', heard: why, conf: '', alts: '', match: '' });
  for (const b of BROWSERS) {
    const opts = b.launch();
    if (!opts) {
      audioRows.push(failRow(b.name, '-', 'not installed'));
      continue;
    }
    for (const file of files) {
      const sidecar = file.replace(/\.wav$/i, '.txt');
      const reference = fs.existsSync(sidecar) ? fs.readFileSync(sidecar, 'utf8').trim() : null;
      let padded;
      try {
        padded = padWav(file, temps.length);
        temps.push(padded.path);
      } catch (err) {
        audioFailures += 1;
        audioRows.push(failRow(b.name, path.basename(file), `ERROR ${err.message}`));
        continue;
      }
      let browser;
      try {
        browser = await chromium.launch({
          ...opts,
          headless: false,
          args: [...LAUNCH_ARGS, `--use-file-for-fake-audio-capture=${padded.path}%noloop`],
        });
      } catch (err) {
        audioRows.push(failRow(b.name, '-', `not installed: ${String(err.message).split('\n')[0].slice(0, 50)}`));
        break;
      }
      if (!takesTrack(browser.version())) {
        audioRows.push(failRow(b.name, path.basename(file), `skipped: ${NO_TRACK}`));
        await browser.close();
        break;
      }
      audioLaunched += 1;
      try {
        const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
        await context.grantPermissions(['microphone'], { origin: new URL(HARNESS_URL).origin });
        for (const lang of LANGS) {
          for (let run = 1; run <= RUNS; run++) {
            const r = await probeAudio(context, lang, Math.max(WAIT_MS, (padded.seconds + 10) * 1000));
            if (!r.ended) audioFailures += 1;
            const top = r.alternatives[0];
            audioRows.push({
              browser: `${b.name} ${browser.version()}`,
              file: path.basename(file),
              lang,
              run,
              heard: top ? `"${top.transcript}"${r.final ? '' : ' (interim)'}` : r.error ? `error:${r.error}` : r.ended ? 'no result' : 'never ended',
              conf: top ? Number(top.confidence).toFixed(2) : '',
              alts: r.alternatives.length,
              match: reference === null ? '-' : top && normaliseSpoken(top.transcript) === normaliseSpoken(reference) ? 'yes' : 'no',
            });
            audioDetails.push({
              browser: b.name,
              version: browser.version(),
              file: path.basename(file),
              reference,
              lang,
              run,
              maxAlternatives: ALTERNATIVES,
              final: r.final,
              alternatives: r.alternatives,
              heard: r.heard,
              error: r.error,
              events: r.log,
            });
          }
        }
      } catch (err) {
        audioFailures += 1;
        audioRows.push(failRow(b.name, path.basename(file), `ERROR ${String(err.message).split('\n')[0].slice(0, 60)}`));
      } finally {
        await browser.close();
      }
    }
  }
  harness.close();
  for (const t of temps) fs.rmSync(t, { force: true });

  if (JSON_FILE) fs.writeFileSync(JSON_FILE, JSON.stringify(audioDetails, null, 2));
  else if (JSON_OUT) console.log(JSON.stringify(audioDetails, null, 2));
  console.log(`audio: ${AUDIO}  (lang ${LANGS.join(', ')}; maxAlternatives ${ALTERNATIVES})`);
  console.table(audioRows);
  if (audioLaunched === 0) {
    console.error('\nNo browser could be launched. Install Chrome or Edge.');
    process.exit(2);
  }
  const judged = audioRows.filter((r) => r.match === 'yes' || r.match === 'no');
  if (judged.length) {
    console.log(`\nTop transcript matched what was said in ${judged.filter((r) => r.match === 'yes').length} of ${judged.length} runs.`);
  }
  if (audioFailures) console.log(`\n${audioFailures} run(s) did not complete.`);
  process.exit(audioFailures === 0 ? 0 : 1);
}

if (AUDIO) await runAudio();

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
    if (!takesTrack(browser.version())) {
      rows.push({ browser: `${b.name} ${browser.version()}`, run, raw: '-', mic: '-', outcome: 'skipped', message: NO_TRACK, ok: 'skip' });
      await browser.close();
      break;
    }
    launched += 1;
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.grantPermissions(['microphone'], { origin: new URL(HARNESS_URL).origin });
      await context.grantPermissions(['microphone'], { origin: new URL(BASE).origin });
      await context.addInitScript({ content: `${FAKE_MIC_JS}\n(${wrapRecognizer})();` });

      const raw = await probeRaw(context);
      const site = await probeSite(context);

      const problems = [];
      if (b.isBrave && site.micVisible) problems.push('mic shown in Brave');
      if (!b.isBrave && !site.micVisible) problems.push(`mic hidden in ${b.name}`);
      if (site.outcome === 'silent') problems.push('ended in silence');
      if (site.outcome === 'stuck') problems.push(`still listening after ${WAIT_MS}ms`);
      if (site.outcome === 'probe-error') problems.push(`probe could not supply the fake microphone: ${site.message}`);
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

if (JSON_FILE) fs.writeFileSync(JSON_FILE, JSON.stringify(details, null, 2));
else if (JSON_OUT) console.log(JSON.stringify(details, null, 2));
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
