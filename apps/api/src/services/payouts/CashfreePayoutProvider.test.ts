import { describe, expect, it } from 'vitest';
import { CASHFREE_PAYOUT_API_VERSION, CashfreePayoutProvider } from './CashfreePayoutProvider';
import { GatewayError } from '../payments/PaymentProvider';

function fakeFetch(replies: Array<{ status: number; body: unknown } | Error>) {
  const sent: { method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> | null }[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    sent.push({
      method: init.method ?? 'GET',
      url: String(input),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    const next = replies.shift();
    if (!next) throw new Error('no scripted reply');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { sent, impl };
}

const make = (impl: typeof fetch) =>
  new CashfreePayoutProvider({ clientId: 'pid', clientSecret: 'psecret', environment: 'sandbox', fetchImpl: impl });

const request = {
  transferId: 'PAYOUT_000007',
  reference: 'PAYOUT-000007',
  amountPaise: 150050,
  destination: 'HDFC ••••1234',
  beneficiaryId: 'CLWB_m1',
  mode: 'banktransfer' as const,
};

describe('CashfreePayoutProvider', () => {
  it('saves a beneficiary once; its own id already saved (409, read back) is fine', async () => {
    const { sent, impl } = fakeFetch([
      { status: 200, body: { beneficiary_id: 'CLWB_m1' } },
      { status: 409, body: { code: 'beneficiary_id_already_exists' } },
      { status: 200, body: { beneficiary_id: 'CLWB_m1' } },
    ]);
    const p = make(impl);
    const b = { id: 'CLWB_m1', name: "Ravi D'Souza", accountNumber: '00011122233', ifsc: 'hdfc0001234', phone: '+919876543210' };
    expect(await p.ensureBeneficiary(b)).toBe('CLWB_m1');
    expect(await p.ensureBeneficiary(b)).toBe('CLWB_m1');
    expect(sent[0]!.url).toBe('https://sandbox.cashfree.com/payout/beneficiary');
    expect(sent[0]!.headers['x-api-version']).toBe(CASHFREE_PAYOUT_API_VERSION);
    expect(sent[0]!.body).toMatchObject({
      beneficiary_id: 'CLWB_m1',
      beneficiary_name: "Ravi D'Souza",
      beneficiary_instrument_details: { bank_account_number: '00011122233', bank_ifsc: 'HDFC0001234' },
      beneficiary_contact_details: { beneficiary_phone: '9876543210' },
    });
  });

  // Pre-launch audit (2026-10-20), H2: every 409 was taken as "saved", so an
  // account already saved under another id was transferred to an id Cashfree
  // never created — "Beneficiary id does not exist", every payout failed.
  it('an account already saved under another id: transfers to that one', async () => {
    const { sent, impl } = fakeFetch([
      { status: 409, body: { code: 'conflict_with_existing_beneficiary', message: 'Beneficiary with the given bank_account_number and bank_ifsc already exists' } },
      { status: 404, body: { code: 'beneficiary_not_found' } },
      { status: 200, body: { beneficiary_id: 'CLWB_old', beneficiary_instrument_details: { bank_account_number: '00011122233', bank_ifsc: 'HDFC0001234' } } },
    ]);
    const b = { id: 'CLWB_m2', name: 'Ravi', accountNumber: '00011122233', ifsc: 'hdfc0001234' };
    expect(await make(impl).ensureBeneficiary(b)).toBe('CLWB_old');
    expect(sent[1]!.url).toBe('https://sandbox.cashfree.com/payout/beneficiary?beneficiary_id=CLWB_m2');
    expect(sent[2]!.method).toBe('GET');
    expect(sent[2]!.url).toBe('https://sandbox.cashfree.com/payout/beneficiary?bank_account_number=00011122233&bank_ifsc=HDFC0001234');
  });

  it('a 409 that matches nothing saved is an error, not a beneficiary', async () => {
    const { impl } = fakeFetch([
      { status: 409, body: { code: 'conflict_with_existing_beneficiary' } },
      { status: 404, body: {} },
      { status: 404, body: {} },
    ]);
    await expect(make(impl).ensureBeneficiary({ id: 'CLWB_m3', name: 'Ravi', accountNumber: '1', ifsc: 'HDFC0001234' })).rejects.toBeInstanceOf(GatewayError);
  });

  it('sends the transfer under our transfer id, in rupees, to the saved beneficiary', async () => {
    const { sent, impl } = fakeFetch([{ status: 200, body: { transfer_id: 'PAYOUT_000007', cf_transfer_id: 'cf9', status: 'RECEIVED', status_code: 'RECEIVED' } }]);
    const t = await make(impl).transfer(request);
    expect(t).toMatchObject({ status: 'PROCESSING', providerTransferId: 'cf9', providerStatus: 'RECEIVED/RECEIVED' });
    expect(sent[0]!.body).toMatchObject({
      transfer_id: 'PAYOUT_000007',
      transfer_amount: 1500.5,
      transfer_mode: 'banktransfer',
      beneficiary_details: { beneficiary_id: 'CLWB_m1' },
    });
  });

  it('is PAID only at SUCCESS/COMPLETED, with the UTR', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { status: 'SUCCESS', status_code: 'COMPLETED', transfer_utr: 'UTR777' } },
      { status: 200, body: { status: 'SUCCESS', status_code: 'SENT_TO_BENEFICIARY' } },
    ]);
    const p = make(impl);
    expect(await p.getTransfer('PAYOUT_000007')).toMatchObject({ status: 'PAID', utr: 'UTR777' });
    expect(await p.getTransfer('PAYOUT_000007')).toMatchObject({ status: 'PROCESSING' });
  });

  it('maps FAILED / REJECTED as failed and REVERSED as reversed, with the reason', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { status: 'FAILED', status_code: 'INVALID_ACCOUNT', status_description: 'Account closed' } },
      { status: 200, body: { status: 'REJECTED', status_code: 'INSUFFICIENT_BALANCE' } },
      { status: 200, body: { status: 'REVERSED', status_code: 'REVERSED', status_description: 'Beneficiary bank returned it' } },
    ]);
    const p = make(impl);
    expect(await p.getTransfer('a')).toMatchObject({ status: 'FAILED', failureReason: 'Account closed' });
    expect(await p.getTransfer('b')).toMatchObject({ status: 'FAILED', failureReason: 'INSUFFICIENT_BALANCE' });
    expect(await p.getTransfer('c')).toMatchObject({ status: 'REVERSED', failureReason: 'Beneficiary bank returned it' });
  });

  it('a duplicate transfer id reads the transfer; an unknown one is null', async () => {
    const { sent, impl } = fakeFetch([
      { status: 409, body: { code: 'transfer_id_already_exists' } },
      { status: 200, body: { status: 'SUCCESS', status_code: 'COMPLETED', transfer_utr: 'U1' } },
      { status: 404, body: { code: 'transfer_not_found' } },
    ]);
    const p = make(impl);
    expect(await p.transfer(request)).toMatchObject({ status: 'PAID', utr: 'U1' });
    expect(sent[1]!.url).toBe('https://sandbox.cashfree.com/payout/transfers?transfer_id=PAYOUT_000007');
    expect(await p.getTransfer('missing')).toBeNull();
  });

  it('a refused transfer (4xx) never left: FAILED; a 5xx or timeout is uncertain and thrown', async () => {
    const { impl } = fakeFetch([
      { status: 422, body: { code: 'insufficient_balance', message: 'Not enough balance' } },
      { status: 502, body: {} },
      Object.assign(new Error('t'), { name: 'TimeoutError' }),
    ]);
    const p = make(impl);
    expect(await p.transfer(request)).toMatchObject({ status: 'FAILED', failureReason: 'Not enough balance' });
    for (let i = 0; i < 2; i++) {
      const err = await p.transfer(request).catch((e) => e);
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).uncertain).toBe(true);
    }
  });

  it('refuses ids Cashfree would reject before calling it', async () => {
    const { sent, impl } = fakeFetch([]);
    await expect(make(impl).transfer({ ...request, transferId: 'PAYOUT-000007' })).rejects.toBeInstanceOf(GatewayError);
    await expect(make(impl).transfer({ ...request, beneficiaryId: null })).rejects.toBeInstanceOf(GatewayError);
    expect(sent).toHaveLength(0);
  });
});

describe('CashfreePayoutProvider.getBalance', () => {
  it('reads the balance through a v1 token on the v1 host, in paise, sending no money', async () => {
    const { sent, impl } = fakeFetch([
      { status: 200, body: { status: 'SUCCESS', subCode: '200', message: 'Token generated', data: { token: 'tok_1', expiry: 1 } } },
      { status: 200, body: { status: 'SUCCESS', subCode: '200', data: { balance: '2147.50', availableBalance: '1739.80' } } },
    ]);
    expect(await make(impl).getBalance()).toEqual({ balancePaise: 214750, availablePaise: 173980 });
    expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST https://payout-gamma.cashfree.com/payout/v1/authorize',
      'GET https://payout-gamma.cashfree.com/payout/v1/getBalance',
    ]);
    expect(sent[0]!.headers).toMatchObject({ 'x-client-id': 'pid', 'x-client-secret': 'psecret' });
    expect(sent[1]!.headers.authorization).toBe('Bearer tok_1');
    expect(sent[1]!.headers['x-client-secret']).toBeUndefined();
  });

  it('uses the production v1 host in production', async () => {
    const { sent, impl } = fakeFetch([
      { status: 200, body: { status: 'SUCCESS', data: { token: 't' } } },
      { status: 200, body: { status: 'SUCCESS', data: { balance: 1, availableBalance: 1 } } },
    ]);
    await new CashfreePayoutProvider({ clientId: 'a', clientSecret: 'b', environment: 'production', fetchImpl: impl }).getBalance();
    expect(sent[0]!.url).toBe('https://payout-api.cashfree.com/payout/v1/authorize');
  });

  it('treats a v1 "ERROR" answered with HTTP 200 as the failure it is, never as a zero balance', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { status: 'ERROR', subCode: '403', message: 'IP not whitelisted' } }]);
    const err = await make(impl).getBalance().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).message).toContain('subCode 403');
    expect((err as GatewayError).message).toContain('IP not whitelisted');
  });

  it('refuses an answer without amounts', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { status: 'SUCCESS', data: { token: 't' } } },
      { status: 200, body: { status: 'SUCCESS', data: {} } },
    ]);
    await expect(make(impl).getBalance()).rejects.toThrow('without amounts');
  });
});
