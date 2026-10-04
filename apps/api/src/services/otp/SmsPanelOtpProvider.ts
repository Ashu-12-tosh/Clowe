import { OtpSendError, type OtpProvider, type OtpSendFailure } from './OtpProvider';

/** DLT's variable marker. The approved template holds exactly one, where the code goes. */
export const TEMPLATE_VAR = '{#var#}';

const SEND_PATH = '/sms-panel/api/http/index.php';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Node's error codes for a certificate that failed verification — OpenSSL's
 * verify codes (CERT_HAS_EXPIRED, UNABLE_TO_VERIFY_LEAF_SIGNATURE, …) and
 * Node's own (ERR_TLS_CERT_ALTNAME_INVALID). They arrive as cause.code on
 * fetch's TypeError('fetch failed').
 */
const TLS_FAILURE =
  /CERT|CRL|^UNABLE_TO_|^INVALID_CA$|^INVALID_PURPOSE$|^PATH_LENGTH_EXCEEDED$|^HOSTNAME_MISMATCH$|^ERR_TLS_|^ERR_SSL_/;

export interface SmsPanelConfig {
  /** https://host — the certificate must verify for this host. */
  baseUrl: string;
  username: string;
  apiKey: string;
  senderId: string;
  templateId: string;
  /** The approved DLT template text with one {#var#}. */
  template: string;
  timeoutMs?: number;
  /** Tests pass a stub; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Sends the login code through the DLT-registered SMS panel's HTTP API.
 *
 * The API key travels in the query string, so the full URL is built in one
 * place and handed straight to fetch: it is never logged, put in an error, or
 * returned. Failures are logged here once, with the host and a cleaned detail,
 * and surface as an OtpSendError that carries only a reason.
 *
 * Certificate verification is never relaxed, and a redirect is refused rather
 * than followed — a redirect would carry the key to wherever it points,
 * plain http included.
 */
export class SmsPanelOtpProvider implements OtpProvider {
  readonly name = 'smspanel';
  readonly host: string;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: SmsPanelConfig) {
    this.origin = panelOrigin(config.baseUrl);
    this.host = new URL(this.origin).host;
    if (!/^[A-Za-z0-9]{6}$/.test(config.senderId)) {
      throw new Error('SMS_PANEL_SENDER_ID must be the 6-character DLT header');
    }
    if (!/^\d+$/.test(config.templateId)) {
      throw new Error('SMS_PANEL_TEMPLATE_ID must be the numeric DLT template ID');
    }
    if (config.template.split(TEMPLATE_VAR).length !== 2) {
      throw new Error(`SMS_PANEL_OTP_TEMPLATE must contain ${TEMPLATE_VAR} exactly once, where the code goes`);
    }
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async sendOtp(phone: string, code: string): Promise<void> {
    const secrets = [this.config.apiKey, this.config.username, code, phone];
    const fail = (reason: OtpSendFailure, detail: string) => {
      console.error(`[clowe-api] SMS OTP not sent: ${clean(detail, secrets)}`);
      return new OtpSendError(reason);
    };

    let text: string;
    let status: number;
    try {
      const res = await this.fetchImpl(this.sendUrl(phone, code), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const { reason, detail } = this.describeFetchError(err);
      throw fail(reason, detail);
    }

    if (status < 200 || status >= 300) {
      throw fail('http_error', `${this.host} answered HTTP ${status}`);
    }

    // The panel answers HTTP 200 for errors too, labelled text/html: only the
    // JSON body says what happened, and only "success" counts as sent.
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw fail('bad_response', `${this.host} did not answer with JSON`);
    }
    const panelStatus = field(body, 'status');
    if (panelStatus?.toLowerCase() === 'success') return;

    const panelMessage = field(body, 'message');
    if (panelStatus === undefined && panelMessage === undefined) {
      throw fail('bad_response', `${this.host} answered JSON without a status`);
    }
    const reason = classifyPanelMessage(panelMessage ?? '');
    throw fail(reason, `${PANEL_REASON_TEXT[reason]} (panel said: "${panelMessage ?? panelStatus}")`);
  }

  /** The only place the full URL exists. Every value is percent-encoded. */
  private sendUrl(phone: string, code: string): string {
    const params: Array<[string, string]> = [
      ['username', this.config.username],
      ['apikey', this.config.apiKey],
      ['apirequest', 'Text'],
      ['sender', this.config.senderId],
      ['mobile', phone],
      ['message', this.config.template.replace(TEMPLATE_VAR, code)],
      ['route', 'TRANS'],
      ['TemplateID', this.config.templateId],
      ['format', 'JSON'],
    ];
    const query = params.map(([k, v]) => `${k}=${encodeParam(v)}`).join('&');
    return `${this.origin}${SEND_PATH}?${query}`;
  }

  private describeFetchError(err: unknown): { reason: OtpSendFailure; detail: string } {
    const e = err as { name?: string; cause?: { code?: string; name?: string } } | null;
    if (e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError') {
      return { reason: 'timeout', detail: `${this.host} did not answer within ${this.timeoutMs / 1000}s` };
    }
    const code = e?.cause?.code;
    if (code && TLS_FAILURE.test(code)) {
      return {
        reason: 'tls',
        detail:
          `the certificate of ${this.host} failed verification (${code}). Nothing was sent. ` +
          'Verification stays on: renew or fix the certificate, or point SMS_PANEL_BASE_URL at a host it covers',
      };
    }
    return { reason: 'network', detail: `could not reach ${this.host}${code ? ` (${code})` : ''}` };
  }
}

const PANEL_REASON_TEXT: Record<OtpSendFailure, string> = {
  low_balance: 'the panel account is out of SMS credit — top it up',
  invalid_template:
    'the panel rejected the DLT template — check SMS_PANEL_TEMPLATE_ID, and that SMS_PANEL_OTP_TEMPLATE matches the approved text exactly',
  invalid_sender: 'the panel rejected the sender — check SMS_PANEL_SENDER_ID',
  auth: 'the panel rejected the username or API key',
  rejected: 'the panel refused the message',
  timeout: 'timeout',
  tls: 'certificate failed verification',
  network: 'network error',
  http_error: 'HTTP error',
  bad_response: 'unreadable answer',
};

/** Order matters: a template error that names the sender is still a template error. */
export function classifyPanelMessage(message: string): OtpSendFailure {
  if (/balance|credit|insufficient/i.test(message)) return 'low_balance';
  if (/template/i.test(message)) return 'invalid_template';
  if (/sender/i.test(message)) return 'invalid_sender';
  if (/api ?key|user ?name|password|authenticat|unauthori[sz]ed/i.test(message)) return 'auth';
  return 'rejected';
}

/** https://host only: no plain http, no credentials, no path or query to hide things in. */
function panelOrigin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('SMS_PANEL_BASE_URL is not a URL');
  }
  if (url.protocol !== 'https:') throw new Error('SMS_PANEL_BASE_URL must start with https://');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('SMS_PANEL_BASE_URL must be just https://host, e.g. https://alots.in');
  }
  return url.origin;
}

/** encodeURIComponent, plus the five characters it leaves alone. */
function encodeParam(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function field(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** One line, bounded, with anything secret (or the code, or the number) masked — even if the panel echoes it. */
function clean(text: string, secrets: string[]): string {
  let out = text.replace(/[\r\n\t]+/g, ' ');
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}
