/**
 * Spec values sellers typed off their facet's list ("hlaf", "plan"), each
 * with the known value it most likely meant ("Half sleeve", "Solid"), for an
 * admin to approve before anything is written.
 *
 * Dry run by default: lists every off-list value, how many products carry
 * it, the suggestion and why, and the token that approves it. Nothing is
 * written. Then apply only what was approved:
 *
 *   dc exec api npx tsx prisma/specTypos.ts                                    # the report (production)
 *   dc exec api npx tsx prisma/specTypos.ts --apply --approve=sleeve:hlaf,pattern:plan
 *   dc exec api npx tsx prisma/specTypos.ts --apply --approve="sleeve:hlf=Half sleeve"   # a different known value
 *   dc exec api npx tsx prisma/specTypos.ts --apply --approve=all              # every row that has a suggestion
 *   npm run db:spec-typos --workspace=@clowe/api [-- ...]                      # dev checkout only
 *
 * npm run fails on the server (tsx: not found): the image prunes dev dependencies.
 */
// env first: it layers .env.local over .env, and nothing may load .env before it.
import '../src/env';
import { prisma } from '../src/db';
import { applySpecFixes, findSpecTypos, type SpecFix, type SpecTypo } from '../src/services/specTypos';

function report(typos: SpecTypo[]) {
  if (typos.length === 0) {
    console.log('[spec-typos] Every listed spec value is on its facet’s list. Nothing to fix.');
    return;
  }
  // Grouped by facet and its known list: categories can list the same facet differently.
  const group = (t: SpecTypo) => `${t.label}  (known: ${t.known.join(', ')})`;
  let current = '';
  for (const t of [...typos].sort((a, b) => group(a).localeCompare(group(b)) || b.productIds.length - a.productIds.length)) {
    if (group(t) !== current) {
      current = group(t);
      console.log(`\n${current}`);
    }
    const what = t.suggestion
      ? `-> ${t.suggestion} (${t.reason})`
      : t.alternatives.length
        ? `?? ${t.alternatives.join(' or ')} (equally close: give one with key:value=Target)`
        : '-- no close match';
    console.log(`  [${t.token}]  "${t.value}" x${t.productIds.length}  ${what}`);
  }
  const suggested = typos.filter((t) => t.suggestion).length;
  console.log(`\n[spec-typos] ${typos.length} off-list values; ${suggested} with a suggestion.`);
}

/** "--approve=a:b,c:d=Target" into fixes, checked against the report. */
function approvals(arg: string, typos: SpecTypo[]): SpecFix[] {
  const byToken = new Map(typos.map((t) => [t.token, t]));
  if (arg === 'all') return typos.filter((t) => t.suggestion).map((t) => ({ key: t.key, from: t.value, to: t.suggestion! }));
  return arg.split(',').map((part) => {
    const [tokenRaw, target] = part.split('=');
    const token = tokenRaw.trim().toLowerCase();
    const typo = byToken.get(token);
    if (!typo) throw new Error(`[spec-typos] ${token} is not in the report`);
    const to = target?.trim() || typo.suggestion;
    if (!to) throw new Error(`[spec-typos] ${token} has no suggestion: give one as ${token}=Target`);
    const known = typo.known.find((k) => k.toLowerCase() === to.toLowerCase());
    if (!known) throw new Error(`[spec-typos] "${to}" is not a known ${typo.label} value (${typo.known.join(', ')})`);
    return { key: typo.key, from: typo.value, to: known };
  });
}

async function main() {
  const apply = process.argv.includes('--apply');
  const approveArg = process.argv.find((a) => a.startsWith('--approve='))?.slice('--approve='.length);
  const typos = await findSpecTypos();

  if (!apply) {
    report(typos);
    console.log('[spec-typos] Dry run: nothing written. Approve rows with --apply --approve=token,token (or =all).');
    return;
  }
  if (!approveArg) throw new Error('[spec-typos] --apply needs --approve=token,token (or --approve=all)');
  const fixes = approvals(approveArg, typos);
  for (const f of fixes) console.log(`  ${f.key}: "${f.from}" -> "${f.to}"`);
  const changed = await applySpecFixes(fixes);
  console.log(`[spec-typos] Applied ${fixes.length} fixes to ${changed} products.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
