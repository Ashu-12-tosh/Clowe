import type { OtpProvider } from './OtpProvider';

/** Dev-only provider: prints the OTP to the API console instead of sending SMS. */
export class MockOtpProvider implements OtpProvider {
  readonly name = 'mock';

  async sendOtp(phone: string, code: string): Promise<void> {
    console.log(`\n[clowe-api] ===== MOCK OTP =====`);
    console.log(`[clowe-api] Phone: +91 ${phone}`);
    console.log(`[clowe-api] OTP:   ${code}`);
    console.log(`[clowe-api] ====================\n`);
  }
}
