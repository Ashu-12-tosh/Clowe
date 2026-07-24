import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { env } from '../../env';
import { uploadDir } from '../../routes/uploads';
import type { TryOnInput, TryOnProvider } from './TryOnProvider';
import { imageUrlToDataUri } from './imageUtils';

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Free dev provider: composites the customer's photo with the garment image
 * into a watermarked SVG preview. No external AI calls — lets the whole flow
 * (upload → generate → history) be tested at zero cost.
 */
export class MockTryOnProvider implements TryOnProvider {
  readonly name = 'mock';
  readonly costPaise = 0;

  async generate(input: TryOnInput): Promise<string> {
    const [personUri, garmentUri] = await Promise.all([
      imageUrlToDataUri(input.personImageUrl),
      imageUrlToDataUri(input.garmentImageUrl).catch(() => null), // garment optional in mock
    ]);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <rect width="600" height="800" fill="#111"/>
  <image href="${personUri}" x="0" y="0" width="600" height="800" preserveAspectRatio="xMidYMid slice"/>
  ${
    garmentUri
      ? `<g>
    <rect x="418" y="558" width="164" height="224" rx="12" fill="#fff" opacity="0.92"/>
    <image href="${garmentUri}" x="426" y="566" width="148" height="188" preserveAspectRatio="xMidYMid slice"/>
    <text x="500" y="772" text-anchor="middle" font-family="Helvetica, Arial" font-size="13" fill="#111">${escapeXml(
      input.productTitle.slice(0, 18),
    )}</text>
  </g>`
      : ''
  }
  <rect x="0" y="0" width="600" height="44" fill="#000" opacity="0.55"/>
  <text x="300" y="28" text-anchor="middle" font-family="Helvetica, Arial" font-size="18" font-weight="bold" fill="#fff" letter-spacing="2">CLOWE AI TRY-ON — MOCK PREVIEW</text>
  <text x="300" y="795" text-anchor="middle" font-family="Helvetica, Arial" font-size="10" fill="#fff" opacity="0.7">Real AI try-on activates when FASHN_API_KEY is configured</text>
</svg>`;

    const filename = `tryon-${Date.now()}-${randomBytes(4).toString('hex')}.svg`;
    await fs.writeFile(path.join(uploadDir, filename), svg, 'utf8');
    return `${env.API_PUBLIC_URL}/uploads/${filename}`;
  }
}
