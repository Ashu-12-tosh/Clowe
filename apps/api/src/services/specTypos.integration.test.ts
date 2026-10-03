import { PrismaClient, ProductStatus, Role, SellerStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedFixture } from '../test/fixture';
import { invalidateCategoryRules } from './categoryRules';
import { applySpecFixes, findSpecTypos } from './specTypos';

/**
 * The typo report: every spec value off its facet's list, with a suggested
 * known value, written only once an admin approves it.
 */

const prisma = new PrismaClient();
const ids: Record<string, string> = {};

beforeAll(async () => {
  await seedFixture(prisma);
  const shirts = await prisma.category.create({
    data: {
      name: 'Typo Shirts', slug: 'typo-shirts', isActive: true,
      facets: {
        add: [
          { key: 'sleeve', label: 'Sleeve', kind: 'list', values: ['Full sleeve', 'Half sleeve', 'Sleeveless'] },
          { key: 'pattern', label: 'Pattern', kind: 'list', values: ['Solid', 'Printed', 'Striped'] },
        ],
        hide: [],
      },
    },
  });
  invalidateCategoryRules();
  const user = await prisma.user.create({ data: { phone: '9192000001', name: 'Typo Seller', role: Role.SELLER, referralCode: 'TYPO-S' } });
  const seller = await prisma.sellerProfile.create({ data: { userId: user.id, shopName: 'Typo Shop', status: SellerStatus.APPROVED } });
  const make = async (name: string, attributes: { key: string; label: string; value: string }[]) => {
    const p = await prisma.product.create({
      data: {
        sellerId: seller.id, categoryId: shirts.id, title: `Typo ${name}`, slug: `typo-${name}`, description: 'Typo report test.',
        basePricePaise: 50_000, status: ProductStatus.APPROVED, attributes,
      },
    });
    ids[name] = p.id;
  };
  const sleeve = (value: string) => ({ key: 'sleeve', label: 'Sleeve', value });
  const pattern = (value: string) => ({ key: 'pattern', label: 'Pattern', value });
  await make('a', [sleeve('hlaf'), pattern('plan'), { key: 'fabric', label: 'Fabric', value: 'Cotton' }]);
  await make('b', [sleeve('hlaf'), pattern('Solid')]);
  await make('c', [sleeve('Half sleeve'), pattern('Zari work')]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const attrs = async (name: string) =>
  ((await prisma.product.findUniqueOrThrow({ where: { id: ids[name] } })).attributes as { key: string; value: string }[]);

describe('the typo report', () => {
  it('lists every off-list value with a suggestion, and how many products carry it', async () => {
    const report = (await findSpecTypos()).filter((t) => Object.values(ids).some((id) => t.productIds.includes(id)));
    expect(report.map((t) => [t.token, t.productIds.length, t.suggestion, t.reason])).toEqual([
      ['sleeve:hlaf', 2, 'Half sleeve', 'word'],
      ['pattern:plan', 1, 'Solid', 'alias'],
      ['pattern:zari work', 1, null, null],
    ]);
    // Reading it writes nothing.
    expect((await attrs('a')).find((r) => r.key === 'sleeve')?.value).toBe('hlaf');
  });

  it('writes only what is approved, and leaves the rest of the sheet as it was', async () => {
    const changed = await applySpecFixes([{ key: 'sleeve', from: 'HLAF', to: 'Half sleeve' }]);
    expect(changed).toBe(2);
    expect(await attrs('a')).toEqual([
      { key: 'sleeve', label: 'Sleeve', value: 'Half sleeve' },
      { key: 'pattern', label: 'Pattern', value: 'plan' },
      { key: 'fabric', label: 'Fabric', value: 'Cotton' },
    ]);
    expect((await attrs('b')).find((r) => r.key === 'sleeve')?.value).toBe('Half sleeve');
    const left = (await findSpecTypos()).map((t) => t.token);
    expect(left).not.toContain('sleeve:hlaf');
    expect(left).toContain('pattern:plan');
  });
});
