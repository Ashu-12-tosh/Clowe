/**
 * Provider-agnostic OTP delivery interface.
 * Implementations: MockOtpProvider (dev), SmsPanelOtpProvider (DLT SMS panel).
 */
export interface OtpProvider {
  readonly name: string;
  /** Deliver the code to the given phone. Throws OtpSendError on delivery failure. */
  sendOtp(phone: string, code: string): Promise<void>;
}

export type OtpSendFailure =
  | 'timeout'
  | 'tls'
  | 'network'
  | 'http_error'
  | 'bad_response'
  | 'auth'
  | 'low_balance'
  | 'invalid_template'
  | 'invalid_sender'
  | 'rejected';

/**
 * The code was not sent. The message is deliberately bare — no URL, number,
 * code or panel text — because whatever catches this may log it. The detail is
 * logged once, cleaned, by the provider that threw it.
 */
export class OtpSendError extends Error {
  constructor(public readonly reason: OtpSendFailure) {
    super(`OTP not sent (${reason})`);
    this.name = 'OtpSendError';
  }
}
