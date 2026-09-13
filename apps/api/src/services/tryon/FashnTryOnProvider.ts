import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { env } from '../../env';
import { uploadDir } from '../../routes/uploads';
import { TryOnError, type TryOnInput, type TryOnProvider } from './TryOnProvider';
import { imageUrlToDataUri } from './imageUtils';

const FASHN_BASE = 'https://api.fashn.ai/v1';

/** How long one HTTP call to FASHN may take before we give up on it. */
const HTTP_TIMEOUT_MS = 30_000;
/** Gap between status polls. Runs finish in ~5-17s depending on mode. */
const POLL_INTERVAL_MS = 2000;
/** Transient (network / 5xx) failures retried per call. */
const MAX_ATTEMPTS = 3;

interface FashnRunResponse {
  id?: string;
  error?: unknown;
}

interface FashnStatusResponse {
  id?: string;
  status?: 'starting' | 'in_queue' | 'processing' | 'completed' | 'failed';
  output?: string[] | null;
  error?: unknown;
}

/** FASHN reports errors as a string, or as an object with a message/name. */
function errText(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const e = error as { message?: unknown; name?: unknown };
    if (typeof e.message === 'string') return e.message;
    if (typeof e.name === 'string') return e.name;
  }
  return JSON.stringify(error);
}

/**
 * What the shopper is told when FASHN rejects us. The raw upstream text is
 * kept for the admin monitor, but it is not something a customer can act on,
 * and a billing or auth problem must not read as "your photo was bad".
 */
function messageForStatus(status: number, detail: string): string {
  if (status === 401 || status === 403) {
    return 'AI Try-On is not configured correctly. Please contact support.';
  }
  if (status === 402) {
    return 'AI Try-On has run out of credits. Please try again later.';
  }
  if (status === 429) {
    return 'AI Try-On is busy right now. Please try again in a minute.';
  }
  if (status >= 500) {
    return 'The AI Try-On service is temporarily unavailable. Please try again.';
  }
  return detail || 'AI Try-On could not process these images.';
}

/** A 5xx or a network blip is worth retrying; a plain 4xx is not. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Real virtual try-on via the FASHN API (https://fashn.ai).
 *
 * Flow: POST /v1/run (model + garment image) -> poll GET /v1/status/:id until
 * completed -> download the output and re-host it under our own /uploads, so
 * the result survives FASHN's CDN links expiring.
 *
 * Images go as base64 data URIs rather than URLs: that is the only thing that
 * works from localhost or a private staging host, and imageUtils has already
 * downscaled them to FASHN's processing size so the payload stays small.
 */
export class FashnTryOnProvider implements TryOnProvider {
  readonly name = 'fashn';

  constructor(
    private readonly apiKey: string,
    readonly costPaise: number,
    private readonly modelName: string = env.FASHN_MODEL,
    private readonly mode: string = env.FASHN_MODE,
    private readonly totalTimeoutMs: number = env.TRYON_TIMEOUT_MS,
  ) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  /** One JSON call to FASHN, with a timeout and retries on transient failures. */
  private async call<T>(
    urlPath: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
  ): Promise<T> {
    let lastError: TryOnError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${FASHN_BASE}${urlPath}`, {
          method: init.method,
          headers: this.headers(),
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
      } catch (err) {
        // Timeout, DNS failure, connection reset - always worth one more try.
        lastError = new TryOnError(
          'The AI Try-On service could not be reached. Please try again.',
          `FASHN ${init.method} ${urlPath} network error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await sleep(500 * attempt);
          continue;
        }
        throw lastError;
      }

      // A gateway or WAF in front of FASHN can answer with HTML, not JSON.
      const raw = await res.text();
      let parsed: unknown = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }

      if (!res.ok) {
        const detail = errText((parsed as { error?: unknown } | null)?.error) || raw.slice(0, 200);
        lastError = new TryOnError(
          messageForStatus(res.status, detail),
          `FASHN ${init.method} ${urlPath} -> ${res.status}: ${detail || res.statusText}`,
        );
        if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS) {
          await sleep(500 * attempt);
          continue;
        }
        throw lastError;
      }

      if (parsed === null) {
        throw new TryOnError(
          'The AI Try-On service returned an unexpected response. Please try again.',
          `FASHN ${init.method} ${urlPath} returned non-JSON: ${raw.slice(0, 200)}`,
        );
      }
      return parsed as T;
    }

    throw lastError ?? new TryOnError('AI Try-On failed.', 'FASHN call exhausted its retries');
  }

  async generate(input: TryOnInput): Promise<string> {
    const deadline = Date.now() + this.totalTimeoutMs;

    const [modelImage, garmentImage] = await Promise.all([
      imageUrlToDataUri(input.personImageUrl),
      imageUrlToDataUri(input.garmentImageUrl),
    ]);

    // 1. Start the prediction. `category` narrows the model's own guess; we
    //    only override its classifier when the product category is clear.
    const run = await this.call<FashnRunResponse>('/run', {
      method: 'POST',
      body: {
        model_name: this.modelName,
        inputs: {
          model_image: modelImage,
          garment_image: garmentImage,
          category: input.garmentCategory ?? 'auto',
          mode: this.mode,
          num_samples: 1,
          output_format: 'jpeg',
          // Fit the garment directly instead of segmenting the photo first:
          // FASHN documents this as better preservation of body shape and skin
          // texture, which is what keeps the shopper's own pose and background
          // intact so only the garment changes.
          segmentation_free: true,
          // Shoppers upload photos of themselves; FASHN's stricter setting is
          // the right default for a consumer marketplace. Our own guards
          // already refuse sensitive garments before we get here — this is the
          // provider-side backstop on the photo itself.
          moderation_level: 'conservative',
        },
      },
    });
    if (!run.id) {
      const detail = errText(run.error);
      throw new TryOnError(
        messageForStatus(400, detail),
        `FASHN /run returned no prediction id: ${detail || 'no error field'}`,
      );
    }

    // 2. Poll until it finishes or we run out of time.
    let outputUrl: string | undefined;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const status = await this.call<FashnStatusResponse>(`/status/${run.id}`, { method: 'GET' });

      if (status.status === 'completed') {
        outputUrl = status.output?.[0];
        if (!outputUrl) {
          throw new TryOnError(
            'AI Try-On finished without producing an image. Please try again.',
            `FASHN prediction ${run.id} completed with an empty output array`,
          );
        }
        break;
      }
      if (status.status === 'failed') {
        const detail = errText(status.error);
        // A failed prediction is usually about the inputs (no person detected,
        // moderation), so the upstream detail is worth showing the shopper.
        throw new TryOnError(
          detail
            ? `AI Try-On could not use these images: ${detail}`
            : 'AI Try-On could not use these images. Try a clearer, front-facing photo.',
          `FASHN prediction ${run.id} failed: ${detail || 'no detail'}`,
        );
      }
    }
    if (!outputUrl) {
      throw new TryOnError(
        'AI Try-On took too long. Please try again.',
        `FASHN prediction ${run.id} did not finish within ${this.totalTimeoutMs} ms`,
      );
    }

    // 3. Re-host the result - FASHN's CDN links expire, ours do not.
    const imgRes = await fetch(outputUrl, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!imgRes.ok) {
      throw new TryOnError(
        'AI Try-On finished but the image could not be saved. Please try again.',
        `Downloading the FASHN output failed (${imgRes.status}): ${outputUrl}`,
      );
    }
    const contentType = imgRes.headers.get('content-type') ?? '';
    const ext = contentType.includes('png') || outputUrl.includes('.png') ? '.png' : '.jpg';
    const filename = `tryon-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
    await fs.writeFile(path.join(uploadDir, filename), Buffer.from(await imgRes.arrayBuffer()));
    return `${env.API_PUBLIC_URL}/uploads/${filename}`;
  }

  /**
   * Cheap credentials check for the startup log and `npm run tryon:check`:
   * asks for a prediction that does not exist. A real key gets 404, a bad one
   * gets 401/403 — either way nothing is generated and nothing is billed.
   */
  async verifyCredentials(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${FASHN_BASE}/status/credential-check`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, detail: `FASHN rejected the API key (HTTP ${res.status})` };
      }
      if (res.status >= 500) {
        return { ok: false, detail: `FASHN is returning ${res.status}; try again shortly` };
      }
      return { ok: true, detail: `FASHN reachable and the key was accepted (HTTP ${res.status})` };
    } catch (err) {
      return {
        ok: false,
        detail: `Could not reach FASHN: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
