import fs from 'node:fs';
import path from 'node:path';

/**
 * Static content pages, backed by markdown files in apps/web/content/pages/.
 * To edit a page: edit its .md file — no code changes needed.
 */
export interface ContentPageMeta {
  slug: string;
  title: string;
  description: string;
}

export const CONTENT_PAGES: ContentPageMeta[] = [
  { slug: 'about', title: 'About Clowe', description: 'Who we are and why we built fashion you can try on yourself.' },
  { slug: 'careers', title: 'Careers', description: 'Join the team building AI-powered fashion commerce.' },
  { slug: 'press', title: 'Press Releases', description: 'Clowe announcements and media resources.' },
  { slug: 'science', title: 'Clowe Science', description: 'The AI technology behind virtual try-on and recommendations.' },
  { slug: 'accelerator', title: 'Clowe Accelerator', description: 'A growth program for ambitious sellers on Clowe.' },
  { slug: 'brand-protection', title: 'Protect and Build Your Brand', description: 'Brand verification, takedowns and counterfeit protection on Clowe.' },
  { slug: 'supply', title: 'Supply to Clowe', description: 'Manufacture or wholesale clothing? Partner with Clowe.' },
  { slug: 'advertise', title: 'Advertise Your Products', description: 'Promoted placements for sellers — clearly labeled, admin-reviewed.' },
  { slug: 'recalls', title: 'Recalls and Product Safety Alerts', description: 'Product recalls and safety notices on Clowe.' },
  { slug: 'purchase-protection', title: '100% Purchase Protection', description: 'Refunds, returns and payment protection on every Clowe order.' },
  { slug: 'app', title: 'Clowe App', description: 'The Clowe mobile app — coming soon.' },
  { slug: 'help', title: 'Help Centre', description: 'Quick answers about orders, returns, accounts and selling.' },
  // Marketplace footer pages
  { slug: 'blog', title: 'Clowe Blog', description: 'Stories, launches and shopping guides from Clowe.' },
  { slug: 'affiliate', title: 'Affiliate Program', description: 'Earn by recommending Clowe products.' },
  { slug: 'faq', title: 'FAQ', description: 'Frequently asked questions about shopping on Clowe.' },
  { slug: 'shipping-info', title: 'Shipping Info', description: 'Delivery timelines, charges and coverage.' },
  { slug: 'returns-refunds', title: 'Returns & Refunds', description: 'How returns and refunds work on Clowe.' },
  { slug: 'cancellation', title: 'Cancellation', description: 'Cancelling an order before it ships.' },
  { slug: 'privacy-policy', title: 'Privacy Policy', description: 'How Clowe handles your data.' },
  { slug: 'terms-conditions', title: 'Terms & Conditions', description: 'The terms that govern using Clowe.' },
  { slug: 'shipping-policy', title: 'Shipping Policy', description: 'Our shipping commitments in detail.' },
  { slug: 'return-policy', title: 'Return Policy', description: 'Eligibility windows and conditions for returns.' },
  { slug: 'payment-policy', title: 'Payment Policy', description: 'Accepted payment methods and how refunds are paid.' },
  { slug: 'cookie-policy', title: 'Cookie Policy', description: 'How Clowe uses cookies and local storage.' },
];

export function getContentPage(slug: string): (ContentPageMeta & { markdown: string }) | null {
  const meta = CONTENT_PAGES.find((p) => p.slug === slug);
  if (!meta) return null;
  const file = path.join(process.cwd(), 'content', 'pages', `${slug}.md`);
  if (!fs.existsSync(file)) return null;
  return { ...meta, markdown: fs.readFileSync(file, 'utf8') };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline markdown: **bold**, *italic*, [text](href), `code`. */
function inline(md: string): string {
  return escapeHtml(md)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" class="font-semibold text-brand-600 hover:underline">$1</a>',
    );
}

/**
 * Tiny markdown → HTML renderer (headings, lists, blockquote, paragraphs).
 * Content is our own repo files — not user input.
 */
export function renderMarkdown(md: string): string {
  const out: string[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (list.length) {
      out.push(`<ul class="mt-3 list-disc space-y-1.5 pl-6 text-gray-700">${list.join('')}</ul>`);
      list = [];
    }
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*-\s+/.test(line)) {
      list.push(`<li>${inline(line.replace(/^\s*-\s+/, ''))}</li>`);
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    if (line.startsWith('### ')) {
      out.push(`<h3 class="mt-6 text-base font-bold text-ink-900">${inline(line.slice(4))}</h3>`);
    } else if (line.startsWith('## ')) {
      out.push(
        `<h2 class="mt-8 font-display text-xl font-bold text-ink-900">${inline(line.slice(3))}</h2>`,
      );
    } else if (line.startsWith('# ')) {
      // h1 handled by the page header — render as display heading if repeated
      out.push(
        `<h1 class="font-display text-3xl font-bold tracking-tight text-ink-900">${inline(line.slice(2))}</h1>`,
      );
    } else if (line.startsWith('> ')) {
      out.push(
        `<blockquote class="mt-4 border-l-4 border-brand-400 pl-4 font-display text-lg italic text-gray-600">${inline(line.slice(2))}</blockquote>`,
      );
    } else if (/^\d+\.\s+/.test(line)) {
      out.push(`<p class="mt-2 pl-2 text-gray-700">${inline(line)}</p>`);
    } else {
      out.push(`<p class="mt-3 leading-relaxed text-gray-700">${inline(line)}</p>`);
    }
  }
  flushList();
  return out.join('\n');
}
