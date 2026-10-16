import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every api() call in the web app sends the method its API route answers.
// api() sends GET unless it is given a method, or POST when it has a body:
// a call to a POST route with neither is a GET the API answers with 404
// (it happened: the shopper's "Cancel order" did nothing).

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_SRC = path.resolve(WEB, '..', 'api', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) out.push(p);
  }
  return out;
}

function apiRoutes(): { method: string; rx: RegExp }[] {
  const app = fs.readFileSync(path.join(API_SRC, 'app.ts'), 'utf8');
  const mounts = new Map<string, string[]>();
  for (const m of app.matchAll(/app\.use\('(\/api[^']*)'\s*,\s*(?:\w+\s*,\s*)*(\w+Router)\)/g)) {
    mounts.set(m[2]!, [...(mounts.get(m[2]!) ?? []), m[1]!]);
  }
  const routes: { method: string; rx: RegExp }[] = [];
  for (const file of fs.readdirSync(path.join(API_SRC, 'routes'))) {
    if (!file.endsWith('.ts') || file.includes('.test.')) continue;
    const src = fs.readFileSync(path.join(API_SRC, 'routes', file), 'utf8');
    for (const m of src.matchAll(/(\w+Router)\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
      for (const prefix of mounts.get(m[1]!) ?? []) {
        const full = (prefix + (m[3] === '/' ? '' : m[3])).replace(/\/$/, '') || '/';
        routes.push({ method: m[2]!.toUpperCase(), rx: new RegExp(`^${full.replace(/:\w+/g, '[^/]+')}$`) });
      }
    }
  }
  return routes;
}

describe('web → API calls', () => {
  it('send the method each route answers', () => {
    const routes = apiRoutes();
    expect(routes.length).toBeGreaterThan(200);
    const wrong: string[] = [];
    let checked = 0;
    const call = /\bapi(?:<[^>]*>)?\(\s*([`'])(\/api[^`']*)\1\s*(?:,\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\})?\s*\)/g;
    for (const file of walk(WEB)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(call)) {
        const opts = m[3] ?? '';
        const explicit = /\bmethod\s*:\s*'(\w+)'/.exec(opts);
        if (/\bmethod\s*:/.test(opts) && !explicit) continue; // computed method
        const hasBody = /\bbody\s*:/.test(opts) || /\bbody\b\s*[,}]/.test(opts);
        const sent = explicit?.[1] ?? (hasBody ? 'POST' : 'GET');
        const target = m[2]!.split('?')[0]!.replace(/\$\{[^}]*\}/g, 'X');
        const answers = new Set(routes.filter((r) => r.rx.test(target)).map((r) => r.method));
        checked++;
        if (answers.size && !answers.has(sent)) {
          wrong.push(`${path.relative(WEB, file)}: ${sent} ${m[2]} (the API answers ${[...answers].join('/')})`);
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(wrong).toEqual([]);
  });
});
