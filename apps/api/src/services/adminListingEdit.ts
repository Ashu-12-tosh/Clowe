import type { Prisma } from '@prisma/client';
import { canonicalAttributes, variantOptionFields, type AdminListingEditInput } from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { auditSafe } from './auditService';
import { linkBrand } from './brands';
import { categoryRulesFor } from './categoryRules';
import { invalidateSearchCatalog } from './productSearch';

/**
 * An admin fixes a listing on the seller's behalf (with their agreement):
 * category, title, brand, descriptions, attributes, sizes and visibility. Applied at once
 * — an admin's edit needs no review — and kept on the record as "Listing
 * edited by Clowe admin" with every value before and after.
 *
 * Pictures replace the listing's set in order (the first is the main one),
 * each with an optional internal note such as "low-res, replace later".
 *
 * Sizes turn the listing's variants into one per size at today's price: a
 * variant already carrying one of the sizes keeps it (and its order history),
 * the first one without becomes the first missing size, the rest are retired
 * (or deleted, if never ordered), and the stock on hand is split evenly — at
 * least 1 each.
 */

interface Snapshot {
  /** The category, and the HSN code it gives the listing (its own or inherited). */
  category: { id: string; name: string; hsnCode: string | null };
  title: string;
  brand: string | null;
  shortDescription: string | null;
  description: string;
  attributes: unknown;
  isVisible: boolean;
  variants: { id: string; label: string; size: string; color: string; stock: number; pricePaise: number }[];
  images: { url: string; qualityNote: string | null }[];
}

async function snapshot(productId: string): Promise<Snapshot> {
  const { category, ...p } = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
    select: {
      category: { select: { id: true, name: true } },
      title: true,
      brand: true,
      shortDescription: true,
      description: true,
      attributes: true,
      isVisible: true,
      variants: { where: { retiredAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, label: true, size: true, color: true, stock: true, pricePaise: true } },
      images: { orderBy: { sortOrder: 'asc' }, select: { url: true, qualityNote: true } },
    },
  });
  return { category: { ...category, hsnCode: (await categoryRulesFor(category.id)).hsnCode }, ...p };
}

/** Each size's share of `total`: as even as it goes, the remainder to the first ones, never below 1. */
export function splitStock(total: number, n: number): number[] {
  const base = Math.floor(Math.max(0, total) / n);
  const extra = Math.max(0, total) - base * n;
  return Array.from({ length: n }, (_, i) => Math.max(1, base + (i < extra ? 1 : 0)));
}

async function freeSku(base: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const sku = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await prisma.productVariant.findUnique({ where: { sku }, select: { id: true } }))) return sku;
  }
  throw new Error(`No free SKU near ${base}`);
}

async function sizeWrites(productId: string, sizes: string[]): Promise<Prisma.PrismaPromise<unknown>[]> {
  const active = await prisma.productVariant.findMany({
    where: { productId, retiredAt: null },
    orderBy: { createdAt: 'asc' },
    include: { _count: { select: { orderItems: true } } },
  });
  if (active.length === 0) throw ApiError.badRequest('This listing has no variant to take the price from', 'NO_VARIANT');
  const base = active[0]!;
  const shares = splitStock(active.reduce((n, v) => n + v.stock, 0), sizes.length);
  const unused = [...active];
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  const plan = new Map<string, (typeof active)[number] | null>();
  // A variant already in one of the sizes keeps it.
  for (const size of sizes) {
    const match = unused.find((v) => v.size.trim().toUpperCase() === size.toUpperCase());
    if (match) {
      plan.set(size, match);
      unused.splice(unused.indexOf(match), 1);
    }
  }
  for (const [i, size] of sizes.entries()) {
    const fields = variantOptionFields({ size }, [], { size, color: '' });
    const reuse = plan.get(size) ?? (unused.length ? unused.shift()! : null);
    if (reuse) {
      writes.push(
        prisma.productVariant.update({
          where: { id: reuse.id },
          data: { optionValues: fields.optionValues, optionsKey: fields.optionsKey, label: fields.label, size: fields.size, color: fields.color, stock: shares[i]! },
        }),
      );
    } else {
      writes.push(
        prisma.productVariant.create({
          data: {
            productId,
            optionValues: fields.optionValues,
            optionsKey: fields.optionsKey,
            label: fields.label,
            size: fields.size,
            color: fields.color,
            sku: await freeSku(`${base.sku}-${size}`),
            pricePaise: base.pricePaise,
            mrpPaise: base.mrpPaise,
            sellerPricePaise: base.sellerPricePaise,
            sellerMrpPaise: base.sellerMrpPaise,
            stock: shares[i]!,
          },
        }),
      );
    }
  }
  // Variants left over: retired if ever ordered (order lines point at them), deleted if not.
  const now = new Date();
  for (const v of unused) {
    writes.push(
      v._count.orderItems > 0
        ? prisma.productVariant.update({ where: { id: v.id }, data: { retiredAt: now, stock: 0, optionsKey: `retired:${v.id}` } })
        : prisma.productVariant.delete({ where: { id: v.id } }),
    );
  }
  if (unused.length) writes.push(prisma.cartItem.deleteMany({ where: { variantId: { in: unused.map((v) => v.id) } } }));
  return writes;
}

export async function adminEditListing(productId: string, input: AdminListingEditInput, adminId: string): Promise<{ before: Snapshot; after: Snapshot }> {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, categoryId: true, seller: { select: { shopName: true } } } });
  if (!product) throw ApiError.notFound('Product not found');
  const before = await snapshot(productId);
  if (input.categoryId !== undefined && input.categoryId !== product.categoryId) {
    const target = await prisma.category.findUnique({ where: { id: input.categoryId }, select: { isActive: true } });
    if (!target?.isActive) throw ApiError.badRequest('Pick an active category', 'CATEGORY_NOT_FOUND');
  }
  const rules = await categoryRulesFor(input.categoryId ?? product.categoryId);
  const brand = input.brand !== undefined ? await linkBrand<{ brand?: string; brandId?: string }>({ brand: input.brand }) : null;

  const data: Prisma.ProductUpdateInput = {
    ...(input.categoryId !== undefined ? { category: { connect: { id: input.categoryId } } } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(brand ? { brand: brand.brand?.trim() || null, brandRef: brand.brandId ? { connect: { id: brand.brandId } } : { disconnect: true } } : {}),
    ...(input.shortDescription !== undefined ? { shortDescription: input.shortDescription || null } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.attributes !== undefined ? { attributes: canonicalAttributes(input.attributes, rules.attributeSchema) as object } : {}),
    ...(input.visible !== undefined ? { isVisible: input.visible } : {}),
  };
  await prisma.$transaction([
    // The product's variants locked first, in id order, as orders lock them.
    prisma.$executeRaw`SELECT 1 FROM "product_variants" WHERE "productId" = ${productId} ORDER BY id COLLATE "C" FOR NO KEY UPDATE`,
    prisma.product.update({ where: { id: productId }, data }),
    ...(input.sizes ? await sizeWrites(productId, input.sizes) : []),
    // Pictures: the set given, in order; the first is the main one.
    ...(input.images
      ? [
          prisma.productImage.deleteMany({ where: { productId } }),
          prisma.productImage.createMany({
            data: input.images.map((img, i) => ({ productId, url: img.url, altText: input.title ?? before.title, sortOrder: i, qualityNote: img.qualityNote || null })),
          }),
        ]
      : []),
  ]);
  const after = await snapshot(productId);
  invalidateSearchCatalog();
  auditSafe({
    actorId: adminId,
    actorRole: 'ADMIN',
    module: 'PRODUCTS',
    action: 'Listing edited by Clowe admin',
    entityType: 'Product',
    entityId: productId,
    summary: `${product.seller.shopName} · ${after.title}: edited by Clowe admin — ${input.reason}`,
    metadata: { reason: input.reason, before, after } as unknown as Record<string, unknown>,
  });
  return { before, after };
}
