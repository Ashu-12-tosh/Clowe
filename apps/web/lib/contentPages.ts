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
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A link target the page may carry: a path on this site, an anchor, or an
 * http(s), mailto: or tel: address. Anything else — javascript:, data:,
 * vbscript: — is dropped. The pages are filled from settings an admin types,
 * so a link there must not be able to run script (pre-launch audit 2026-10-20).
 */
export function safeHref(escaped: string): string | null {
  // Entities decoded and control characters dropped first, as a browser would.
  const href = escaped
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[\u0000-\u0020\u007f]/g, '');
  if (/^(\/(?!\/)|#|\?)/.test(href)) return escaped;
  if (/^(https?:\/\/|mailto:|tel:)/i.test(href)) return escaped;
  return null;
}

/** Inline markdown: **bold**, *italic*, [text](href), `code`. */
function inline(md: string): string {
  return escapeHtml(md)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, href: string) => {
      const safe = safeHref(href.trim());
      return safe
        ? `<a href="${safe}" class="font-semibold text-brand-600 hover:underline">${text}</a>`
        : text;
    });
}

/** A pipe-table row ("| a | b |") as its cells, or null for any other line. */
function tableCells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2) return null;
  return t.slice(1, -1).split('|').map((c) => c.trim());
}

/** A cell's lines ("<br>" between them), each escaped and inline-formatted. */
function cellLines(cell: string): string {
  return cell
    .split(/\s*<br\s*\/?>\s*/i)
    .filter((l) => l !== '')
    .map((l) => `<span class="block">${inline(l)}</span>`)
    .join('');
}

/**
 * A table that reads on any screen: a plain table from `sm` up; below it,
 * each row stacks as a block — the number (when the first column is one, like
 * "Sl. No.") and the first named column in bold on one line, then every other
 * column on its own line under its header ("Basis: …", "Rate: …"). Nothing
 * scrolls sideways.
 */
function renderTable(rows: string[][]): string {
  const [head, ...body] = rows;
  const numbered = /^(sl\.?\s*no\.?|no\.?|#)$/i.test(head[0] ?? '');
  const titleCol = numbered ? 1 : 0;
  const desktop = 'sm:table-cell sm:border-b sm:border-gray-100 sm:px-3 sm:py-2.5 sm:align-top';
  const th = head
    .map((h) => `<th scope="col" class="border-b border-gray-200 px-3 py-2 text-left align-bottom text-xs font-bold uppercase tracking-wide text-gray-500">${inline(h)}</th>`)
    .join('');
  const tr = body
    .map((cells) => {
      const tds = head
        .map((h, i) => {
          const value = cells[i] ?? '';
          if (numbered && i === 0) {
            return `<td class="inline pr-1.5 font-bold text-ink-900 ${desktop}">${inline(value)}<span class="sm:hidden">.</span></td>`;
          }
          if (i === titleCol) {
            return `<td class="inline font-bold text-ink-900 ${desktop}">${inline(value)}</td>`;
          }
          return `<td class="mt-1 block ${desktop}"><span class="font-semibold text-gray-500 sm:hidden">${inline(h)}:</span>${cellLines(value)}</td>`;
        })
        .join('');
      return `<tr class="block border-b border-gray-100 py-3 sm:table-row sm:py-0">${tds}</tr>`;
    })
    .join('');
  return (
    `<table class="mt-4 block w-full text-sm leading-relaxed text-gray-700 sm:table sm:border-collapse">` +
    `<thead class="hidden sm:table-header-group"><tr>${th}</tr></thead>` +
    `<tbody class="block sm:table-row-group">${tr}</tbody></table>`
  );
}

/**
 * Tiny markdown → HTML renderer (headings, lists, blockquote, paragraphs and
 * pipe tables). Content is our own repo files plus settings an admin types:
 * everything is escaped, and links are limited to safe targets (safeHref).
 */
export function renderMarkdown(md: string): string {
  const out: string[] = [];
  let list: string[] = [];
  let table: string[][] = [];
  const flushList = () => {
    if (list.length) {
      out.push(`<ul class="mt-3 list-disc space-y-1.5 pl-6 text-gray-700">${list.join('')}</ul>`);
      list = [];
    }
  };
  const flushTable = () => {
    if (table.length > 1) out.push(renderTable(table));
    table = [];
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const cells = tableCells(line);
    if (cells) {
      flushList();
      // The "| --- | --- |" line under the header only marks it as one.
      if (!cells.every((c) => /^:?-{3,}:?$/.test(c))) table.push(cells);
      continue;
    }
    flushTable();
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
  flushTable();
  flushList();
  return out.join('\n');
}
