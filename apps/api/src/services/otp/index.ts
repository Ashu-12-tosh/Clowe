import { env } from '../../env';
import { createOtpProvider, missingPanelSettings } from './select';
import { SmsPanelOtpProvider } from './SmsPanelOtpProvider';

export const otpProvider = createOtpProvider(env);

/** Say which provider is live. No probe send: every SMS is billed. */
export function logOtpProviderStatus(): void {
  if (otpProvider instanceof SmsPanelOtpProvider) {
    console.log(
      `[clowe-api] OTP: SMS panel (${otpProvider.host}, sender ${env.SMS_PANEL_SENDER_ID}, template ${env.SMS_PANEL_TEMPLATE_ID}, route TRANS)`,
    );
    return;
  }
  if (env.OTP_PROVIDER === 'smspanel') {
    console.error(
      `[clowe-api] OTP: OTP_PROVIDER=smspanel but ${missingPanelSettings(env).join(', ')} not set — using the mock, no SMS is sent`,
    );
  }
  const line = '[clowe-api] OTP: mock provider — codes are printed to this log, no SMS is sent';
  if (env.NODE_ENV === 'production') console.warn(line);
  else console.log(line);
}

export { OtpSendError } from './OtpProvider';
export type { OtpProvider, OtpSendFailure } from './OtpProvider';
