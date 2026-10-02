import { colorFamilyOf } from './colorFamily';

// ---------------------------------------------------------------------------
// The filter rail in the URL.
//
// Every filter lives in the query string, so a filtered page can be shared
// and the back button steps back through filters. These build the next query
// from the current one; the pages push it.
//
//   f[key]=a&f[key]=b   a category facet, one parameter per value
//   brands=A,B          brands
//   rating=4            customer rating at or above
//   discount=20         percent off at or above
//   inStock=1           only what can be bought now
//   minPrice / maxPrice rupees
//
// Older links carry opt[key]=a,b, sizes=… and colors=…; editing a facet moves
// its values to f[key] (a colour as its family).
// ---------------------------------------------------------------------------

const LEGACY_LIST: Record<string, string> = { size: 'sizes', color: 'colors' };

/** Parameters that hold a rail filter, besides f[…] and opt[…]. */
const RAIL_PARAMS = ['brands', 'minPrice', 'maxPrice', 'rating', 'discount', 'inStock', 'sizes', 'colors'];

function facetKeyOf(param: string): string | null {
  const m = /^f\[([a-z][a-z0-9_]*)\]$/.exec(param);
  return m ? m[1] : null;
}

const csv = (value: string | null) => (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The values currently chosen for one rail parameter, older link forms included. */
export function selectedValues(params: URLSearchParams, param: string): string[] {
  const key = facetKeyOf(param);
  if (key) {
    const values = [...params.getAll(param), ...csv(params.get(`opt[${key}]`)), ...csv(params.get(LEGACY_LIST[key] ?? ''))];
    const shown = key === 'color' ? values.map((v) => colorFamilyOf(v) ?? v) : values;
    return shown.filter((v, i) => shown.findIndex((w) => same(w, v)) === i);
  }
  if (param === 'brands') return csv(params.get('brands'));
  const single = params.get(param);
  return single ? [single] : [];
}

/** The query with one value of a facet switched on or off (page reset). */
export function withValueToggled(
  params: URLSearchParams,
  facet: { param: string; multi: boolean },
  value: string,
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete('page');
  const current = selectedValues(params, facet.param);
  const on = current.some((v) => same(v, value));
  const key = facetKeyOf(facet.param);
  if (key) {
    const values = on ? current.filter((v) => !same(v, value)) : [...current, value];
    next.delete(facet.param);
    next.delete(`opt[${key}]`);
    if (LEGACY_LIST[key]) next.delete(LEGACY_LIST[key]);
    for (const v of values) next.append(facet.param, v);
    return next;
  }
  if (facet.multi) {
    const values = on ? current.filter((v) => !same(v, value)) : [...current, value];
    if (values.length) next.set(facet.param, values.join(','));
    else next.delete(facet.param);
    return next;
  }
  if (on) next.delete(facet.param);
  else next.set(facet.param, value);
  return next;
}

/** The query without one applied filter — what removing its chip does. */
export function withChipRemoved(params: URLSearchParams, chip: { param: string; value: string }): URLSearchParams {
  if (chip.param === 'price') {
    const next = new URLSearchParams(params);
    next.delete('page');
    next.delete('minPrice');
    next.delete('maxPrice');
    return next;
  }
  const multi = chip.param === 'brands' || facetKeyOf(chip.param) !== null;
  const chosen = selectedValues(params, chip.param).some((v) => same(v, chip.value));
  return chosen ? withValueToggled(params, { param: chip.param, multi }, chip.value) : new URLSearchParams(params);
}

/** The query with every rail filter gone; the search words, category and sort stay. */
export function withRailCleared(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of [...next.keys()]) {
    if (RAIL_PARAMS.includes(key) || key === 'page' || /^(f|opt)\[/.test(key)) next.delete(key);
  }
  return next;
}

/** How many rail filters are applied: one per value, one for a price range. */
export function railFilterCount(params: URLSearchParams): number {
  let count = 0;
  const facetParams = new Set<string>();
  for (const key of params.keys()) {
    const m = /^(?:f|opt)\[([a-z][a-z0-9_]*)\]$/.exec(key);
    if (m) facetParams.add(`f[${m[1]}]`);
  }
  if (params.get('sizes')) facetParams.add('f[size]');
  if (params.get('colors')) facetParams.add('f[color]');
  for (const p of facetParams) count += selectedValues(params, p).length;
  count += csv(params.get('brands')).length;
  if (params.get('minPrice') || params.get('maxPrice')) count += 1;
  for (const p of ['rating', 'discount', 'inStock']) if (params.get(p)) count += 1;
  return count;
}
