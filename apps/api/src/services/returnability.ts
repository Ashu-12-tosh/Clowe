import { prisma } from '../db';
import { categoryRows, categoryRulesFor, chainOf, rulesFromChain } from './categoryRules';
import { hiddenCategoryIds } from './shopperVisibility';

/**
 * Whether something can be returned at all. The category tree decides — a
 * category sets "Returnable" on or off, a subcategory can override its parent,
 * and the default is yes. Sellers cannot make a non-returnable item
 * returnable. Checkout fixes the answer on each order line, like the window.
 */
export async function returnableFor(categoryId: string): Promise<boolean> {
  return (await categoryRulesFor(categoryId)).returnable;
}

/** Each product's returnability right now, for checkout to store on its lines. */
export async function saleReturnability(productIds: string[]): Promise<Map<string, boolean>> {
  const products = await prisma.product.findMany({
    where: { id: { in: [...new Set(productIds)] } },
    select: { id: true, categoryId: true },
  });
  const out = new Map<string, boolean>();
  for (const p of products) out.set(p.id, await returnableFor(p.categoryId));
  return out;
}

/** An order line's returnability: what it was sold with, else (lines written without checkout) today's rule. */
export async function orderLineReturnable(line: { returnable: boolean | null; product: { categoryId: string } }): Promise<boolean> {
  return line.returnable ?? returnableFor(line.product.categoryId);
}

/**
 * The categories shoppers can see where nothing can be returned, by name
 * ("Fashion › Innerwear"): the top-most such category only, since everything
 * under it inherits the rule. Listed on the Return Policy page.
 */
export async function nonReturnableCategoryNames(): Promise<string[]> {
  const rows = await categoryRows();
  const hidden = await hiddenCategoryIds();
  const names: string[] = [];
  for (const row of rows.values()) {
    if (!row.isActive || hidden.has(row.id) || row.returnable !== false) continue;
    const chain = chainOf(rows, row.id);
    if (chain.some((c) => !c.isActive || hidden.has(c.id))) continue;
    // Covered already when an ancestor is itself non-returnable.
    const parent = chain[1];
    if (parent && !rulesFromChain(chain.slice(1)).returnable) continue;
    names.push(chain.reverse().map((c) => c.name).join(' › '));
  }
  return names.sort((a, b) => a.localeCompare(b));
}
