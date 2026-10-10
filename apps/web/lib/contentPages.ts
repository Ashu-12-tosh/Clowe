import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_PAGES, type ContentPageMeta } from './contentPageList';

export { CONTENT_PAGES, type ContentPageMeta } from './contentPageList';

/**
 * Static content pages, backed by markdown files in apps/web/content/pages/.
 * To edit a page: edit its .md file — no code changes needed. Write the
 * return window as {{returnWindow}} and the business as {{legal.name}} (see
 * fillLegalEntity): the page fills both from platform settings.
 */
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
