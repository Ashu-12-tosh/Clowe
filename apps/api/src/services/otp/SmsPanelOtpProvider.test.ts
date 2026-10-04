import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OtpSendError } from './OtpProvider';
import { SmsPanelOtpProvider, type SmsPanelConfig } from './SmsPanelOtpProvider';
import { createOtpProvider, missingPanelSettings } from './select';

/**
 * The SMS panel's answers mapped to ours, with fetch stubbed — no network, no
 * SMS, no bill.
 *
 * The rules pinned here are the ones a quiet regression would turn into a leak
 * or a bad send: the API key, code and number never reach a log line or an
 * error; route is TRANS and the text is the approved template; every value is
 * percent-encoded; only "success" counts as sent.
 */

const API_KEY = 'KEY-s3cr3t-a1b2c3';
const USERNAME = 'clowe-panel-user';
const PHONE = '9876543210';
const CODE = '482913';
const TEMPLATE = 'Your Clowe login code is {#var#}. It expires in 5 minutes. Do not share it - Clowe';

interface Call {
  url: string;
  init: RequestInit;
}

function stub(respond: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

/** What the panel really sends: JSON, but labelled text/html, HTTP 200 even for errors. */
const panel = (body: unknown, status = 200) => () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  });

function provider(fetchImpl: typeof fetch, extra: Partial<SmsPanelConfig> = {}) {
  return new SmsPanelOtpProvider({
    baseUrl: 'https://alots.in',
    username: USERNAME,
    apiKey: API_KEY,
    senderId: 'CLOWEE',
    templateId: '1207168000000012345',
    template: TEMPLATE,
    fetchImpl,
    ...extra,
  });
}

let logged: string[];
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

async function failure(promise: Promise<unknown>): Promise<OtpSendError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof OtpSendError) return err;
    throw err;
  }
  throw new Error('expected an OtpSendError');
}

/** Nothing that left the provider — logs or the error — carries a secret, the code, the number or the URL. */
function expectNothingLeaked(err?: OtpSendError) {
  const out = [...logged, err?.message ?? '', err?.stack ?? '', String(err), JSON.stringify(err ?? {})].join('\n');
  for (const secret of [API_KEY, USERNAME, CODE, PHONE, 'apikey=', 'index.php', '?username']) {
    expect(out).not.toContain(secret);
  }
}

// ---------------------------------------------------------------------------

describe('the request', () => {
  it('is one GET to the panel with route TRANS and the code placed in the approved template', async () => {
    const { fetchImpl, calls } = stub(panel({ status: 'success', message: 'Message sent' }));
    await provider(fetchImpl).sendOtp(PHONE, CODE);

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://alots.in/sms-panel/api/http/index.php');
    expect(calls[0].init.method).toBe('GET');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      username: USERNAME,
      apikey: API_KEY,
      apirequest: 'Text',
      sender: 'CLOWEE',
      mobile: PHONE,
      message: TEMPLATE.replace('{#var#}', CODE),
      route: 'TRANS',
      TemplateID: '1207168000000012345',
      format: 'JSON',
    });
  });

  it('percent-encodes every value, so nothing in one can be read as another parameter', async () => {
    const { fetchImpl, calls } = stub(panel({ status: 'success' }));
    const template = "Code {#var#} & more: 100% + ₹5 = (it's) #1 *now*! a=b?c";
    await provider(fetchImpl, { template, apiKey: 'k&route=PROMO#x', username: 'u ser+1' }).sendOtp(PHONE, CODE);

    const query = calls[0].url.split('?')[1];
    // Nothing but the separators and percent-escapes outside [A-Za-z0-9-_.~].
    for (const pair of query.split('&')) expect(pair).toMatch(/^[A-Za-z]+=[A-Za-z0-9\-_.~%]*$/);
    const params = new URL(calls[0].url).searchParams;
    expect(params.getAll('route')).toEqual(['TRANS']);
    expect(params.get('apikey')).toBe('k&route=PROMO#x');
    expect(params.get('username')).toBe('u ser+1');
    expect(params.get('message')).toBe(template.replace('{#var#}', CODE));
  });

  it('refuses redirects and sets a 10s timeout', async () => {
    const { fetchImpl, calls } = stub(panel({ status: 'success' }));
    await provider(fetchImpl).sendOtp(PHONE, CODE);
    expect(calls[0].init.redirect).toBe('error');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('logs nothing on success — not the code, not the number', async () => {
    const { fetchImpl } = stub(panel({ status: 'success' }));
    await provider(fetchImpl).sendOtp(PHONE, CODE);
    expect(logged).toEqual([]);
  });
});

describe('the panel answer', () => {
  it.each([
    ['success', { status: 'success', message: 'Message sent successfully' }],
    ['success, any case', { status: 'Success', data: { msgid: 'abc' } }],
  ])('%s → sent', async (_label, body) => {
    const { fetchImpl } = stub(panel(body));
    await expect(provider(fetchImpl).sendOtp(PHONE, CODE)).resolves.toBeUndefined();
  });

  it.each([
    // The panel's real answer to a wrong key, seen with an unauthenticated probe.
    ['auth', 'You have entered wrong API KEY please enter correct API key'],
    ['auth', 'Invalid username'],
    ['low_balance', 'Insufficient Balance'],
    ['low_balance', 'You do not have enough credits'],
    ['invalid_template', 'Invalid Template ID'],
    ['invalid_template', 'Template not matched with sender'],
    ['invalid_sender', 'Invalid Sender ID'],
    ['rejected', 'Mobile number is in DND'],
  ])('%s ← "%s"', async (reason, message) => {
    const { fetchImpl } = stub(panel({ status: 'error', message }));
    const err = await failure(provider(fetchImpl).sendOtp(PHONE, CODE));
    expect(err.reason).toBe(reason);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('[clowe-api] SMS OTP not sent');
    expect(logged[0]).toContain(message);
    expectNothingLeaked(err);
  });

  it('masks the key, code and number even when the panel echoes them back', async () => {
    const { fetchImpl } = stub(
      panel({ status: 'error', message: `Bad key ${API_KEY} for ${USERNAME}: "${CODE}" to ${PHONE}\nline two` }),
    );
    const err = await failure(provider(fetchImpl).sendOtp(PHONE, CODE));
    expectNothingLeaked(err);
    expect(logged[0]).not.toContain('\n');
  });

  it('a status other than success is a failure, never assumed sent', async () => {
    const { fetchImpl } = stub(panel({ status: 'queued' }));
    expect((await failure(provider(fetchImpl).sendOtp(PHONE, CODE))).reason).toBe('rejected');
  });

  it.each([
    ['an HTML page', '<html><body>Maintenance</body></html>'],
    ['JSON without a status', { ok: 1 }],
    ['a bare JSON value', 'true'],
  ])('%s → bad_response', async (_label, body) => {
    const { fetchImpl } = stub(panel(body));
    const err = await failure(provider(fetchImpl).sendOtp(PHONE, CODE));
    expect(err.reason).toBe('bad_response');
    expectNothingLeaked(err);
  });

  it('an HTTP error → http_error', async () => {
    const { fetchImpl } = stub(panel('oops', 502));
    const err = await failure(provider(fetchImpl).sendOtp(PHONE, CODE));
    expect(err.reason).toBe('http_error');
    expect(logged[0]).toContain('alots.in answered HTTP 502');
    expectNothingLeaked(err);
  });
});

describe('when the panel cannot be reached', () => {
  /** What Node's fetch throws: TypeError('fetch failed') with the TLS/socket error as its cause. */
  const fetchFailed = (code: string, message: string) => {
    const cause = Object.assign(new Error(message), { code });
    return Object.assign(new TypeError('fetch failed'), { cause });
  };

  it('a certificate that fails verification → tls, with a clear log line and nothing sent', async () => {
    const { fetchImpl } = stub(() => {
      throw fetchFailed(
        'ERR_TLS_CERT_ALTNAME_INVALID',
        `Hostname/IP does not match certificate's altnames: https://alots.in/sms-panel/api/http/index.php?apikey=${API_KEY}`,
      );
    });
    const err = await failure(provider(fetchImpl).sendOtp(PHONE, CODE));
    expect(err.reason).toBe('tls');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('certificate of alots.in failed verification (ERR_TLS_CERT_ALTNAME_INVALID)');
    expect(logged[0]).toContain('Verification stays on');
    expectNothingLeaked(err);
  });

  it.each([
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'CERT_REVOKED',
    'HOSTNAME_MISMATCH',
  ])(
    '%s → tls',
    async (code) => {
      const { fetchImpl } = stub(() => {
        throw fetchFailed(code, 'certificate problem');
      });
      expect((await failure(provider(fetchImpl).sendOtp(PHONE, CODE))).reason).toBe('tls');
    },
  );

  it('no answer within the timeout → timeout', async () => {
    const { fetchImpl } = stub(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal!.addEventListener('abort', () => reject(call.init.signal!.reason));
        }),
    );
    const err = await failure(provider(fetchImpl, { timeoutMs: 20 }).sendOtp(PHONE, CODE));
    expect(err.reason).toBe('timeout');
    expect(logged[0]).toContain('alots.in did not answer within 0.02s');
    expectNothingLeaked(err);
  });

  it('a refused connection → network', async () => {
    const { fetchImpl } = stub(() => {
      throw fetchFailed('ECONNREFUSED', `connect ECONNREFUSED 123.108.46.13:443`);
    });
    const err = await failure(provider(fetchImpl).sendOtp(PHONE, CODE));
    expect(err.reason).toBe('network');
    expect(logged[0]).toContain('could not reach alots.in (ECONNREFUSED)');
    expectNothingLeaked(err);
  });
});

describe('configuration', () => {
  const { fetchImpl } = stub(panel({ status: 'success' }));

  it.each([
    ['http://alots.in', 'must start with https://'],
    ['https://alots.in/sms-panel', 'must be just https://host'],
    ['https://user:pw@alots.in', 'must be just https://host'],
    ['alots.in', 'is not a URL'],
  ])('rejects base URL %s', (baseUrl, message) => {
    expect(() => provider(fetchImpl, { baseUrl })).toThrow(message);
  });

  it('accepts a trailing slash on the base URL', async () => {
    const s = stub(panel({ status: 'success' }));
    await provider(s.fetchImpl, { baseUrl: 'https://alots.in/' }).sendOtp(PHONE, CODE);
    expect(s.calls[0].url.startsWith('https://alots.in/sms-panel/api/http/index.php?')).toBe(true);
  });

  it.each([
    ['no {#var#}', 'Your code is 123'],
    ['two {#var#}', 'Code {#var#}, valid {#var#} min'],
  ])('rejects a template with %s', (_label, template) => {
    expect(() => provider(fetchImpl, { template })).toThrow('exactly once');
  });

  it.each(['CLOWE', 'CLOWEEE', 'CLO-WE'])('rejects sender %s', (senderId) => {
    expect(() => provider(fetchImpl, { senderId })).toThrow('6-character');
  });

  it('rejects a non-numeric template ID', () => {
    expect(() => provider(fetchImpl, { templateId: 'TPL-1' })).toThrow('numeric');
  });
});

describe('provider selection', () => {
  const full = {
    OTP_PROVIDER: 'smspanel' as const,
    SMS_PANEL_BASE_URL: 'https://alots.in',
    SMS_PANEL_USERNAME: USERNAME,
    SMS_PANEL_API_KEY: API_KEY,
    SMS_PANEL_SENDER_ID: 'CLOWEE',
    SMS_PANEL_TEMPLATE_ID: '1207168000000012345',
    SMS_PANEL_OTP_TEMPLATE: TEMPLATE,
  };

  it('mock is the default, even with every panel setting present', () => {
    expect(createOtpProvider({ ...full, OTP_PROVIDER: 'mock' }).name).toBe('mock');
  });

  it('smspanel with every setting → the panel', () => {
    expect(createOtpProvider(full).name).toBe('smspanel');
  });

  it('smspanel with a setting missing → the mock, and names (not values) what is missing', () => {
    const partial = { ...full, SMS_PANEL_API_KEY: undefined, SMS_PANEL_OTP_TEMPLATE: undefined };
    expect(createOtpProvider(partial).name).toBe('mock');
    expect(missingPanelSettings(partial)).toEqual(['SMS_PANEL_API_KEY', 'SMS_PANEL_OTP_TEMPLATE']);
  });

  it('smspanel with a malformed setting stops the server rather than sending wrong texts', () => {
    expect(() => createOtpProvider({ ...full, SMS_PANEL_BASE_URL: 'http://alots.in' })).toThrow('https://');
  });
});
