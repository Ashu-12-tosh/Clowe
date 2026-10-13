import { prisma } from '../../db';
import type { OtpSendRecord } from './SmsPanelOtpProvider';

/**
 * Keep one SMS OTP send attempt in the database (otp_send_logs). The record
 * arrives already masked and cleaned by the provider: no code, no key, no
 * full number. Errors propagate to the provider, which logs them and sends
 * the code regardless.
 */
export async function storeOtpSend(record: OtpSendRecord): Promise<void> {
  await prisma.otpSendLog.create({ data: { ...record } });
}
