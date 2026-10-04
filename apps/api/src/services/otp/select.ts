import type { env } from '../../env';
import type { OtpProvider } from './OtpProvider';
import { MockOtpProvider } from './MockOtpProvider';
import { SmsPanelOtpProvider } from './SmsPanelOtpProvider';

export type OtpEnv = Pick<
  typeof env,
  | 'OTP_PROVIDER'
  | 'SMS_PANEL_BASE_URL'
  | 'SMS_PANEL_USERNAME'
  | 'SMS_PANEL_API_KEY'
  | 'SMS_PANEL_SENDER_ID'
  | 'SMS_PANEL_TEMPLATE_ID'
  | 'SMS_PANEL_OTP_TEMPLATE'
>;

const PANEL_SETTINGS = [
  'SMS_PANEL_USERNAME',
  'SMS_PANEL_API_KEY',
  'SMS_PANEL_SENDER_ID',
  'SMS_PANEL_TEMPLATE_ID',
  'SMS_PANEL_OTP_TEMPLATE',
] as const;

/** Names (never values) of the panel settings that are not set. */
export function missingPanelSettings(e: OtpEnv): string[] {
  return PANEL_SETTINGS.filter((k) => !e[k]);
}

/**
 * Provider selection:
 * - OTP_PROVIDER=mock     → the mock (the default)
 * - OTP_PROVIDER=smspanel → the SMS panel; while any of its settings is
 *   missing, the mock, with a warning at boot naming what is missing
 *
 * A setting that is present but malformed (http:// URL, a template without
 * exactly one {#var#}) stops the server instead: that is a typo to fix, and
 * the error says which setting.
 */
export function createOtpProvider(e: OtpEnv): OtpProvider {
  if (e.OTP_PROVIDER !== 'smspanel' || missingPanelSettings(e).length > 0) {
    return new MockOtpProvider();
  }
  return new SmsPanelOtpProvider({
    baseUrl: e.SMS_PANEL_BASE_URL,
    username: e.SMS_PANEL_USERNAME!,
    apiKey: e.SMS_PANEL_API_KEY!,
    senderId: e.SMS_PANEL_SENDER_ID!,
    templateId: e.SMS_PANEL_TEMPLATE_ID!,
    template: e.SMS_PANEL_OTP_TEMPLATE!,
  });
}
