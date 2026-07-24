import { env } from '../../env';
import type { OtpProvider } from './OtpProvider';
import { MockOtpProvider } from './MockOtpProvider';

function createOtpProvider(): OtpProvider {
  switch (env.OTP_PROVIDER) {
    case 'mock':
    default:
      return new MockOtpProvider();
    // case 'msg91': return new Msg91OtpProvider(); // Phase 9 / production
    // case 'twilio': return new TwilioOtpProvider();
  }
}

export const otpProvider = createOtpProvider();
export type { OtpProvider };
