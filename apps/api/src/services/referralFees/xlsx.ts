import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Just enough of .xlsx to read one sheet's cell values, with no dependency:
// the zip's central directory, the shared strings, the workbook's sheet list
// and the sheet's cells (as their cached values — what Excel last showed).
// ---------------------------------------------------------------------------

/** One row: column letter → the cell's text, or null. */
export type SheetRow = Record<string, string | null>;

function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not an .xlsx file (no zip directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged .xlsx (zip directory)');
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(start, start + compressed);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, inflateRawSync(raw));
    p += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) =>
    e.startsWith('#x') || e.startsWith('#X')
      ? String.fromCodePoint(parseInt(e.slice(2), 16))
      : e.startsWith('#')
        ? String.fromCodePoint(Number(e.slice(1)))
        : (ENTITIES[e.toLowerCase()] ?? ''),
  );
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]!] = decode(m[2]!);
  return out;
}

/** Text of every <t> inside a fragment, joined (rich text runs included). */
function texts(fragment: string): string {
  return [...fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]!)).join('');
}

/** The sheet names in the workbook, in order. */
export function sheetNames(path: string): string[] {
  const files = unzip(readFileSync(path));
  const workbook = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  return [...workbook.matchAll(/<sheet\s[^>]*\/?>/g)].map((m) => attrs(m[0]).name ?? '');
}

/** Every row of one sheet, as cached cell values. */
export function readSheet(path: string, sheetName: string): SheetRow[] {
  const files = unzip(readFileSync(path));
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!));
  const workbook = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const sheet = [...workbook.matchAll(/<sheet\s[^>]*\/?>/g)].map((m) => attrs(m[0])).find((a) => a.name === sheetName);
  if (!sheet) throw new Error(`No sheet named "${sheetName}"`);
  const rel = [...rels.matchAll(/<Relationship\s[^>]*\/?>/g)].map((m) => attrs(m[0])).find((a) => a.Id === sheet['r:id']);
  if (!rel?.Target) throw new Error(`Sheet "${sheetName}" has no part`);
  const target = rel.Target.replace(/^\//, '');
  const xml = files.get(target.startsWith('xl/') ? target : `xl/${target}`)?.toString('utf8');
  if (!xml) throw new Error(`Sheet "${sheetName}" is missing from the file`);

  const rows: SheetRow[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
    const cells: SheetRow = {};
    for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(cell[1]!);
      const column = /^[A-Z]+/.exec(a.r ?? '')?.[0];
      if (!column) continue;
      const body = cell[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      cells[column] =
        a.t === 's' && v !== undefined
          ? (shared[Number(v)] ?? null)
          : a.t === 'inlineStr'
            ? texts(body)
            : v !== undefined
              ? decode(v)
              : null;
    }
    rows.push(cells);
  }
  return rows;
}
