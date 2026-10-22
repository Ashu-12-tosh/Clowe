import { webPublicUrl } from '../../env';

/**
 * Clowe's one email layout: the crown and wordmark, a heading, the message,
 * an optional button, and a short footer. Plain and light, so it reads the
 * same in Gmail, Outlook and on a phone, and still makes sense with images
 * blocked. Every email also goes out as plain text.
 */

export interface EmailContent {
  /** The heading; also the subject unless one is given. */
  title: string;
  /** Plain text; blank lines start a new paragraph. */
  body: string;
  /** Site path (/orders/…) or a full URL. */
  ctaHref?: string | null;
  ctaLabel?: string | null;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A site path made absolute on the storefront; full http(s) URLs are kept, anything else dropped. */
export function absoluteLink(href: string | null | undefined): string | null {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  if (!href.startsWith('/') || href.startsWith('//')) return null;
  return `${webPublicUrl.replace(/\/$/, '')}${href}`;
}

export function renderEmail(c: EmailContent): { html: string; text: string } {
  const site = webPublicUrl.replace(/\/$/, '');
  const link = absoluteLink(c.ctaHref);
  const label = c.ctaLabel || 'Open Clowe';
  const year = new Date().getFullYear();
  const paragraphs = c.body
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#222222;">${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const button = link
    ? `<p style="margin:22px 0 6px;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:8px;">${escapeHtml(label)}</a></p>`
    : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(c.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f5f2;">
<span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(c.body.slice(0, 120))}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f2;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #ebe8e1;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<tr><td align="center" style="padding:22px 24px 14px;border-bottom:1px solid #f0ede6;">
<a href="${escapeHtml(site)}" style="text-decoration:none;color:#111111;">
<img src="${escapeHtml(site)}/brand/wordmark-black-480.png" width="160" height="40" alt="CLOWE SHOP" style="display:block;margin:0 auto;border:0;width:160px;height:auto;max-width:160px;">
</a>
</td></tr>
<tr><td style="padding:24px 28px 20px;">
<h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;color:#111111;">${escapeHtml(c.title)}</h1>
${paragraphs}${button}
</td></tr>
<tr><td style="padding:16px 28px 22px;border-top:1px solid #f0ede6;font-size:12px;line-height:1.5;color:#777777;">
This is an automatic email from Clowe. To ask us anything, just reply, or write to <a href="mailto:support@cloweshop.com" style="color:#777777;">support@cloweshop.com</a>.<br>
&copy; ${year} CLOWE PARTNERS LLP &middot; <a href="${escapeHtml(site)}" style="color:#777777;">cloweshop.com</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  const text = [
    'CLOWE SHOP',
    '',
    c.title,
    '',
    c.body.trim(),
    ...(link ? ['', `${label}: ${link}`] : []),
    '',
    '—',
    'This is an automatic email from Clowe. To ask us anything, just reply, or write to support@cloweshop.com.',
    `© ${year} CLOWE PARTNERS LLP · cloweshop.com`,
  ].join('\n');
  return { html, text };
}
