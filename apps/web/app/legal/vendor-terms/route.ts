import { NextResponse } from 'next/server';
import { fillLegalEntity, fillPolicyText, VENDOR_TERMS_VERSION } from '@clowe/shared';
import { getContentPage, renderMarkdown } from '@/lib/contentPages';
import { serverPublicSettings } from '@/lib/serverSettings';

/**
 * The Vendor Terms and Seller Agreement as HTML, with the platform's figures
 * and the legal entity filled in — what a seller reads in the acceptance
 * window at registration, and again when the version changes.
 */
export async function GET() {
  const page = getContentPage('seller-terms');
  if (!page) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const settings = await serverPublicSettings();
  const html = renderMarkdown(fillLegalEntity(fillPolicyText(page.markdown, settings), settings?.legalEntity));
  return NextResponse.json({ version: VENDOR_TERMS_VERSION, html }, { headers: { 'cache-control': 'no-store' } });
}
