import { describe, expect, it } from 'vitest';
import { CashfreeEasySplitClient, istStamp } from './easySplitClient';
import { GatewayError } from '../payments/PaymentProvider';

/**
 * The Easy Split calls as Cashfree's sandbox accepts them (checked against
 * the sandbox on 2026-10-19): "E-commerce" as the business type, and the
 * release call's settlementEligibilityDate in "yyyy-MM-dd HH:mm:ss", India time.
 */
function fakeFetch(replies: Array<{ status: number; body: unknown }>) {
  const sent: { method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> | null }[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    sent.push({
      method: init.method ?? 'GET',
      url: String(input),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    const next = replies.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { sent, impl };
}

const make = (impl: typeof fetch) => new CashfreeEasySplitClient({ clientId: 'id', clientSecret: 'secret', environment: 'sandbox', fetchImpl: impl });

describe('CashfreeEasySplitClient', () => {
  it('creates a vendor without asking Cashfree to re-verify the account', async () => {
    const { sent, impl } = fakeFetch([{ status: 200, body: { status: 'IN_BANK_VALIDATION' } }]);
    const status = await make(impl).createVendor({
      vendorId: 'CLW_s1',
      name: 'John Doe',
      email: 'v@example.com',
      phone: '9876543210',
      bank: { accountNumber: '00011020001772', accountHolder: 'John Doe', ifsc: 'HDFC0000001' },
      pan: 'ABCCD8000T',
      gstin: '29AAICP2912R1ZR',
      accountType: 'BUSINESS',
      businessType: 'E-commerce',
    });
    expect(status).toBe('IN_BANK_VALIDATION');
    expect(sent[0]!.url).toBe('https://sandbox.cashfree.com/pg/easy-split/vendors');
    expect(sent[0]!.body).toMatchObject({
      vendor_id: 'CLW_s1',
      verify_account: false,
      bank: { account_number: '00011020001772', ifsc: 'HDFC0000001' },
      kyc_details: { account_type: 'BUSINESS', business_type: 'E-commerce', pan: 'ABCCD8000T', gst: '29AAICP2912R1ZR' },
    });
  });

  it('releases a share on the older host, with the date field and format Cashfree accepts', async () => {
    const { sent, impl } = fakeFetch([{ status: 200, body: { status: 'OK', message: 'Updated vendor settlement eligibility date.' } }]);
    const at = new Date('2026-10-19T17:58:15Z');
    await make(impl).release('CLW-1', 'CLW_s1', at);
    expect(sent[0]).toMatchObject({
      method: 'PUT',
      url: 'https://test.cashfree.com/api/v2/easy-split/orders/CLW-1/settlement-eligibility/vendors/CLW_s1',
      body: { settlementEligibilityDate: '2026-10-19 23:28:15' },
    });
    expect(sent[0]!.headers['x-client-id']).toBe('id');
  });

  it('a refused release (deferred settlement off) is an error, not a silent success', async () => {
    const { impl } = fakeFetch([{ status: 400, body: { status: 'ERROR', subCode: '400', message: 'Deferred settlement not enabled for merchant 1' } }]);
    await expect(make(impl).release('CLW-1', 'CLW_s1', new Date())).rejects.toBeInstanceOf(GatewayError);
  });

  it('formats India time', () => {
    expect(istStamp(new Date('2026-01-31T20:00:00Z'))).toBe('2026-02-01 01:30:00');
  });
});
