/**
 * Provider-agnostic OTP delivery interface.
 * Implementations: MockOtpProvider (dev). MSG91/Twilio slot in here later
 * without touching the auth flow.
 */
export interface OtpProvider {
  readonly name: string;
  /** Deliver the code to the given phone. Throws on delivery failure. */
  sendOtp(phone: string, code: string): Promise<void>;
}
