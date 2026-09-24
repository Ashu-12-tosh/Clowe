import { constants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CashfreeKycProvider } from './CashfreeKycProvider';
import { KycProviderError } from './KycProvider';

/**
 * Cashfree's answers mapped to ours, with fetch stubbed — no network, no bill.
 *
 * The rules pinned here are the ones a quiet regression would turn into money
 * or a data leak: one request per call and never a retry; the bank name sent
 * only when asked for; nothing from the response beyond verdict and score.
 */

interface Call {
  url: string;
  init: RequestInit;
}

function stub(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, fetchMock: fetchImpl };
}

function provider(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof CashfreeKycProvider>[0]> = {}) {
  return new CashfreeKycProvider({
    clientId: 'CF_CLIENT',
    clientSecret: 'CF_SECRET',
    environment: 'sandbox',
    fetchImpl,
    ...extra,
  });
}

const sent = (call: Call) => JSON.parse(String(call.init.body)) as Record<string, unknown>;
const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof KycProviderError) return err.reason;
    throw err;
  }
  throw new Error('expected a KycProviderError');
}

// ---------------------------------------------------------------------------

describe('PAN', () => {
  const ok = {
    pan: 'ABCDE1234F',
    valid: true,
    pan_status: 'VALID',
    registered_name: 'RAHUL SHARMA',
    name_pan_card: 'RAHUL SHARMA',
    name_match_score: '100.00',
    name_match_result: 'DIRECT_MATCH',
    aadhaar_seeding_status: 'Y',
    aadhaar_seeding_status_desc: 'Aadhaar is linked to PAN',
  };

  it('posts pan and name to the sandbox, with the credentials and nothing else', async () => {
    const { fetchImpl, calls } = stub(200, ok);
    await provider(fetchImpl).verifyPAN('ABCDE1234F', 'Rahul Sharma');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://sandbox.cashfree.com/verification/pan');
    expect(sent(calls[0]!)).toEqual({ pan: 'ABCDE1234F', name: 'Rahul Sharma' });
    expect(header(calls[0]!, 'x-client-id')).toBe('CF_CLIENT');
    expect(header(calls[0]!, 'x-client-secret')).toBe('CF_SECRET');
  });

  it('never asks for an API version — newer ones add Aadhaar seeding status', async () => {
    const { fetchImpl, calls } = stub(200, ok);
    await provider(fetchImpl).verifyPAN('ABCDE1234F', 'Rahul Sharma');
    expect(header(calls[0]!, 'x-api-version')).toBeUndefined();
  });

  it('goes to the production host in production', async () => {
    const { fetchImpl, calls } = stub(200, ok);
    await provider(fetchImpl, { environment: 'production' }).verifyPAN('ABCDE1234F', 'Rahul Sharma');
    expect(calls[0]!.url).toBe('https://api.cashfree.com/verification/pan');
  });

  it('passes on the verdict and the score, and nothing else it was told', async () => {
    const { fetchImpl } = stub(200, ok);
    const result = await provider(fetchImpl).verifyPAN('ABCDE1234F', 'Rahul Sharma');
    expect(result).toEqual({ status: 'VERIFIED', reason: null, nameMatch: { score: 100, band: 'DIRECT_MATCH' } });
    // Registered name, Aadhaar seeding — none of it leaves the provider class.
    const text = JSON.stringify(result);
    expect(text).not.toContain('RAHUL');
    expect(text).not.toContain('aadhaar');
    expect(text).not.toContain('"Y"');
  });

  it('reads the score from the string Cashfree sends, without recomputing it', async () => {
    const { fetchImpl } = stub(200, { ...ok, name_match_score: '84.60', name_match_result: 'MODERATE_PARTIAL_MATCH' });
    const result = await provider(fetchImpl).verifyPAN('ABCDE1234F', 'R Sharma');
    expect(result.nameMatch).toEqual({ score: 85, band: 'MODERATE_PARTIAL_MATCH' });
  });

  it('keeps a poor name match a verified PAN — the admin judges the name', async () => {
    const { fetchImpl } = stub(200, { ...ok, name_match_score: '40.00', name_match_result: 'POOR_PARTIAL_MATCH' });
    const result = await provider(fetchImpl).verifyPAN('ABCDE1234F', 'Somebody Else');
    expect(result.status).toBe('VERIFIED');
    expect(result.nameMatch).toEqual({ score: 40, band: 'POOR_PARTIAL_MATCH' });
  });

  it('reports a deleted or deactivated PAN as inactive', async () => {
    for (const pan_status of ['DELETED', 'DEACTIVATED']) {
      const { fetchImpl } = stub(200, { ...ok, valid: false, pan_status });
      expect(await provider(fetchImpl).verifyPAN('ABCDE1234F', 'x')).toEqual({
        status: 'FAILED',
        reason: 'PAN_INACTIVE',
        nameMatch: null,
      });
    }
  });

  it('reports a PAN that does not exist as invalid', async () => {
    const { fetchImpl } = stub(200, { valid: false, pan_status: 'INVALID' });
    expect((await provider(fetchImpl).verifyPAN('ABCDE1234F', 'x')).reason).toBe('PAN_INVALID');
  });

  it('sends a name with an apostrophe in characters Cashfree accepts', async () => {
    const { fetchImpl, calls } = stub(200, ok);
    await provider(fetchImpl).verifyPAN('ABCDE1234F', "Anita D'Souza");
    expect(sent(calls[0]!).name).toBe('Anita D Souza');
  });
});

describe('GSTIN', () => {
  it('sends the GSTIN alone, under the capitalised key Cashfree expects', async () => {
    const { fetchImpl, calls } = stub(200, { valid: true, gst_in_status: 'Active' });
    await provider(fetchImpl).verifyGSTIN('29ABCDE1234F1Z5', 'Rahul Traders');
    expect(calls[0]!.url).toBe('https://sandbox.cashfree.com/verification/gstin');
    // No business_name: Cashfree returns no match for it.
    expect(sent(calls[0]!)).toEqual({ GSTIN: '29ABCDE1234F1Z5' });
  });

  it('verifies an active GSTIN, with no name match to report', async () => {
    const { fetchImpl } = stub(200, { valid: true, gst_in_status: 'Active', legal_name_of_business: 'X' });
    expect(await provider(fetchImpl).verifyGSTIN('29ABCDE1234F1Z5')).toEqual({
      status: 'VERIFIED',
      reason: null,
      nameMatch: null,
    });
  });

  it('fails a registered but cancelled GSTIN as inactive', async () => {
    const { fetchImpl } = stub(200, { valid: true, gst_in_status: 'Cancelled' });
    expect((await provider(fetchImpl).verifyGSTIN('29ABCDE1234F1Z5')).reason).toBe('GSTIN_INACTIVE');
  });

  it('fails an unknown GSTIN as not found', async () => {
    const { fetchImpl } = stub(200, { valid: false, message: "GSTIN Doesn't Exist" });
    expect((await provider(fetchImpl).verifyGSTIN('29ABCDE1234F1Z5')).reason).toBe('GSTIN_NOT_FOUND');
  });
});

describe('bank account', () => {
  const ok = {
    account_status: 'VALID',
    account_status_code: 'ACCOUNT_IS_VALID',
    name_at_bank: 'RAHUL SHARMA',
    name_match_score: '90.00',
    name_match_result: 'GOOD_PARTIAL_MATCH',
  };

  it('sends no name when none is asked for — the match is billed on its own', async () => {
    const { fetchImpl, calls } = stub(200, ok);
    const result = await provider(fetchImpl).verifyBank('1234567890', 'HDFC0001234', null);
    expect(calls[0]!.url).toBe('https://sandbox.cashfree.com/verification/bank-account/sync');
    expect(sent(calls[0]!)).toEqual({ bank_account: '1234567890', ifsc: 'HDFC0001234' });
    expect(result).toEqual({ status: 'VERIFIED', reason: null, nameMatch: null });
  });

  it('sends the name, and reports the match, when asked', async () => {
    const { fetchImpl, calls } = stub(200, ok);
    const result = await provider(fetchImpl).verifyBank('1234567890', 'HDFC0001234', 'Rahul Sharma');
    expect(sent(calls[0]!).name).toBe('Rahul Sharma');
    expect(result.nameMatch).toEqual({ score: 90, band: 'GOOD_PARTIAL_MATCH' });
    expect(JSON.stringify(result)).not.toContain('RAHUL'); // the name at the bank stays there
  });

  it('maps each account status code to a reason', async () => {
    const cases: [string, string][] = [
      ['INVALID_ACCOUNT_FAIL', 'ACCOUNT_INVALID'],
      ['ACCOUNT_BLOCKED', 'ACCOUNT_BLOCKED'],
      ['INVALID_IFSC_FAIL', 'IFSC_INVALID'],
      ['NRE_ACCOUNT_FAIL', 'NRE_ACCOUNT'],
    ];
    for (const [account_status_code, reason] of cases) {
      const { fetchImpl } = stub(200, { account_status: 'INVALID', account_status_code });
      expect((await provider(fetchImpl).verifyBank('1234567890', 'HDFC0001234', null)).reason).toBe(reason);
    }
  });

  it('treats a fraud flag as an answer about the account, not an outage', async () => {
    const { fetchImpl } = stub(422, { code: 'fraud_account', message: 'Fraud detected', type: 'validation_error' });
    expect(await provider(fetchImpl).verifyBank('1234567890', 'HDFC0001234', null)).toEqual({
      status: 'FAILED',
      reason: 'FRAUD_ACCOUNT',
      nameMatch: null,
    });
  });

  it('treats the bank being unreachable as no answer at all', async () => {
    for (const code of ['npci_unavailable', 'connection_timeout', 'bene_bank_declined']) {
      const { fetchImpl } = stub(422, { code });
      expect(await reasonOf(provider(fetchImpl).verifyBank('1234567890', 'HDFC0001234', null))).toBe(
        'BANK_UNAVAILABLE',
      );
    }
  });
});

describe('failures', () => {
  it('make exactly one request and never retry — a retry on a paid API is a second bill', async () => {
    for (const status of [500, 502, 503]) {
      const { fetchImpl, fetchMock } = stub(status, { code: 'verification_failed' });
      expect(await reasonOf(provider(fetchImpl).verifyPAN('ABCDE1234F', 'x'))).toBe('PROVIDER_UNAVAILABLE');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('do not retry a network failure either — the request may already have been served', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const p = provider(fetchMock as unknown as typeof fetch);
    expect(await reasonOf(p.verifyBank('1234567890', 'HDFC0001234', null))).toBe('NETWORK');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('are mapped to reasons an admin can act on', async () => {
    const cases: [number, string, string][] = [
      [401, 'authentication_failed', 'PROVIDER_AUTH'],
      [403, 'ip_validation_failed', 'PROVIDER_AUTH'],
      [400, 'x-client-secret_value_invalid', 'PROVIDER_AUTH'],
      [422, 'insufficient_balance', 'PROVIDER_BALANCE'],
      [429, 'too_many_requests_per_ip', 'PROVIDER_BUSY'],
      [400, 'GSTIN_value_invalid', 'REQUEST_REJECTED'],
    ];
    for (const [status, code, reason] of cases) {
      const { fetchImpl } = stub(status, { code });
      expect(await reasonOf(provider(fetchImpl).verifyGSTIN('29ABCDE1234F1Z5'))).toBe(reason);
    }
  });

  it('keep what was sent out of the log line, even when Cashfree echoes it back', async () => {
    const { fetchImpl } = stub(400, { code: 'pan_value_invalid', message: 'ABCDE1234F is not a valid PAN' });
    try {
      await provider(fetchImpl).verifyPAN('ABCDE1234F', 'Rahul Sharma');
      throw new Error('expected a failure');
    } catch (err) {
      expect(err).toBeInstanceOf(KycProviderError);
      const detail = (err as KycProviderError).detail;
      expect(detail).toBe('/pan: HTTP 400 pan_value_invalid');
      expect(detail).not.toContain('ABCDE1234F');
    }
  });

  it('treat a 200 without a verdict as no answer, rather than cache a guess', async () => {
    const { fetchImpl } = stub(200, {});
    expect(await reasonOf(provider(fetchImpl).verifyPAN('ABCDE1234F', 'x'))).toBe('PROVIDER_UNAVAILABLE');
  });
});

describe('2FA signature', () => {
  it('is clientId.unixSeconds, RSA-OAEP encrypted with the public key Cashfree issued', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const { fetchImpl, calls } = stub(200, { valid: true, gst_in_status: 'Active' });

    await provider(fetchImpl, { publicKeyPem: pem }).verifyGSTIN('29ABCDE1234F1Z5');

    const signature = header(calls[0]!, 'x-cf-signature');
    expect(signature).toBeTruthy();
    const plaintext = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
      Buffer.from(signature!, 'base64'),
    ).toString();
    const [clientId, seconds] = plaintext.split('.');
    expect(clientId).toBe('CF_CLIENT');
    expect(Math.abs(Number(seconds) - Date.now() / 1000)).toBeLessThan(5);
  });

  it('is not sent when the account relies on an IP allowlist', async () => {
    const { fetchImpl, calls } = stub(200, { valid: true, gst_in_status: 'Active' });
    await provider(fetchImpl).verifyGSTIN('29ABCDE1234F1Z5');
    expect(header(calls[0]!, 'x-cf-signature')).toBeUndefined();
  });
});
