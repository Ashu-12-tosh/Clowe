import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { OtpSendError } from './OtpProvider';
import { SmsPanelOtpProvider } from './SmsPanelOtpProvider';
import { storeOtpSend } from './sendLog';

/**
 * Every SMS OTP send attempt lands in otp_send_logs, accepted or not, so it
 * outlives the container's log (which a deploy throws away). Never the code,
 * the API key or the full number.
 */

const prisma = new PrismaClient();
const API_KEY = 'KEY-db-test-9f8e7d';
const PHONE = '9198300042';
const CODE = '730194';

function provider(answer: unknown) {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  return new SmsPanelOtpProvider({
    baseUrl: 'https://alots.in',
    username: 'CLOWE',
    apiKey: API_KEY,
    senderId: 'CLOWEP',
    templateId: '1777179076693657384',
    template: '{#num#} is your OTP for CLOWE login.\nCLOWEP',
    fetchImpl,
    onSend: storeOtpSend,
  });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('otp_send_logs', () => {
  it('keeps an accepted send and a refused one, with nothing secret in either', async () => {
    const before = new Date();
    await provider({ status: 'success', 'message-id': ['8c97-312-0813-b801'], message: 'SMS Sent Successfully' }).sendOtp(PHONE, CODE);
    await expect(
      provider({ status: 'error', message: `Insufficient balance (key ${API_KEY})` }).sendOtp(PHONE, CODE),
    ).rejects.toBeInstanceOf(OtpSendError);

    const rows = await prisma.otpSendLog.findMany({ where: { createdAt: { gte: before } }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.phoneMasked, r.accepted, r.reason, r.messageId, r.panelMessage])).toEqual([
      ['xxxxxx0042', true, null, '8c97-312-0813-b801', 'SMS Sent Successfully'],
      ['xxxxxx0042', false, 'low_balance', null, 'Insufficient balance (key ***)'],
    ]);
    const all = JSON.stringify(rows);
    for (const secret of [API_KEY, PHONE, CODE]) expect(all).not.toContain(secret);
  });
});
