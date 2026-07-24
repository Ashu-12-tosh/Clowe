import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { env } from '../../env';
import { uploadDir } from '../../routes/uploads';
import type { TryOnInput, TryOnProvider } from './TryOnProvider';
import { imageUrlToDataUri } from './imageUtils';

const FASHN_BASE = 'https://api.fashn.ai/v1';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 90_000;

interface FashnRunResponse {
  id?: string;
  error?: string | { message?: string } | null;
}

interface FashnStatusResponse {
  id: string;
  status: 'starting' | 'in_queue' | 'processing' | 'completed' | 'failed';
  output?: string[] | null;
  error?: string | { message?: string } | null;
}

function errText(error: FashnRunResponse['error']): string {
  if (!error) return 'Unknown FASHN error';
  return typeof error === 'string' ? error : (error.message ?? JSON.stringify(error));
}

/**
 * Real virtual try-on via the FASHN API (https://fashn.ai).
 * Flow: POST /v1/run (model + garment image) → poll GET /v1/status/:id until
 * completed → download the output image and re-host it under our /uploads so
 * the result stays available after FASHN's CDN links expire.
 *
 * Local /uploads images are sent as base64 data URIs, so this works from
 * localhost too (FASHN can't fetch a localhost URL).
 */
export class FashnTryOnProvider implements TryOnProvider {
  readonly name = 'fashn';

  constructor(
    private readonly apiKey: string,
    readonly costPaise: number,
  ) {}

  private headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  async generate(input: TryOnInput): Promise<string> {
    const [modelImage, garmentImage] = await Promise.all([
      imageUrlToDataUri(input.personImageUrl),
      imageUrlToDataUri(input.garmentImageUrl),
    ]);

    // 1. Start the prediction.
    const runRes = await fetch(`${FASHN_BASE}/run`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model_name: 'tryon-v1.6',
        inputs: {
          model_image: modelImage,
          garment_image: garmentImage,
          category: 'auto',
        },
      }),
    });
    const runData = (await runRes.json()) as FashnRunResponse;
    if (!runRes.ok || !runData.id) {
      throw new Error(`FASHN run failed: ${errText(runData.error) || runRes.statusText}`);
    }

    // 2. Poll for completion.
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let outputUrl: string | undefined;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const statusRes = await fetch(`${FASHN_BASE}/status/${runData.id}`, {
        headers: this.headers(),
      });
      const statusData = (await statusRes.json()) as FashnStatusResponse;
      if (statusData.status === 'completed') {
        outputUrl = statusData.output?.[0];
        break;
      }
      if (statusData.status === 'failed') {
        throw new Error(`FASHN try-on failed: ${errText(statusData.error)}`);
      }
    }
    if (!outputUrl) throw new Error('FASHN try-on timed out');

    // 3. Re-host the result locally (FASHN CDN links expire).
    const imgRes = await fetch(outputUrl);
    if (!imgRes.ok) throw new Error(`Could not download FASHN result (${imgRes.status})`);
    const ext = outputUrl.includes('.png') ? '.png' : '.jpg';
    const filename = `tryon-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
    await fs.writeFile(path.join(uploadDir, filename), Buffer.from(await imgRes.arrayBuffer()));
    return `${env.API_PUBLIC_URL}/uploads/${filename}`;
  }
}
