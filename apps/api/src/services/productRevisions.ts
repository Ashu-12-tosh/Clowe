import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { categoryRulesFor } from './categoryRules';
import { ensureSellerPrices, recordOrderLineGstRates, repriceProducts } from './sellerPricing';
import { isSensitiveForTryOn } from './tryon/sensitiveGarment';

// ---------------------------------------------------------------------------
// Edits to live listings.
//
// What a buyer sees is content: title, descriptions, category, brand, spec
// sheet, highlights, the product video, the pictures, and the variants on
// offer. A change to any of it on a live listing waits for review in a
// ProductRevision, and the listing stays exactly as approved — on the
// storefront and in carts — until an admin approves it. Everything else
// (price, stock, SKU, dimensions, SEO, visibility…) saves straight onto the
// listing, because none of it is what review exists to check.
// ---------------------------------------------------------------------------

export const newSku = () => `CLW-${randomBytes(4).toString('hex').toUpperCase()}`;

interface VariantOptions {
  optionValues: Record<string, string>;
  optionsKey: string;
  label: string;
  size: string;
  color: string;
}

/** A live variant whose options or pictures the edit changes. */
export interface VariantContentEdit extends VariantOptions {
  id: string;
  /** Present only when the pictures change. */
  imageUrls?: string[];
}

/** A variant the edit adds. */
export interface NewVariantContent extends VariantOptions {
  sku: string | null;
  /** Buyer price and MRP, GST included, on the live category when saved. */
  pricePaise: number;
  mrpPaise: number | null;
  /** The seller's, before GST; absent on edits saved before sellers entered ex-GST. */
  sellerPricePaise?: number | null;
  sellerMrpPaise?: number | null;
  stock: number;
  imageUrls: string[];
}

export interface ListingContent {
  title: string;
  categoryId: string;
  brand: string | null;
  brandId: string | null;
  shortDescription: string | null;
  description: string;
  videoUrl: string | null;
  attributes: unknown;
  highlights: string[];
  imageUrls: string[];
  variantEdits: VariantContentEdit[];
  newVariants: NewVariantContent[];
}

export const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Key-order-independent equality for the JSON spec sheet. A listing saved without one stores null, the form sends []: both mean none. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

interface LiveListing {
  title: string;
  categoryId: string;
  brand: string | null;
  brandId: string | null;
  shortDescription: string | null;
  description: string;
  videoUrl: string | null;
  attributes: Prisma.JsonValue;
  highlights: Prisma.JsonValue;
  images: { url: string }[];
}

/** Whether a proposed content snapshot differs from the live listing at all. */
export function contentDiffers(content: ListingContent, live: LiveListing): boolean {
  return (
    content.title !== live.title ||
    content.categoryId !== live.categoryId ||
    content.brand !== live.brand ||
    content.brandId !== live.brandId ||
    content.shortDescription !== live.shortDescription ||
    content.description !== live.description ||
    content.videoUrl !== live.videoUrl ||
    stable(content.attributes ?? []) !== stable(live.attributes ?? []) ||
    stable(content.highlights ?? []) !== stable(live.highlights ?? []) ||
    !sameList(content.imageUrls, live.images.map((i) => i.url)) ||
    content.variantEdits.length > 0 ||
    content.newVariants.length > 0
  );
}

/** The fields an admin sees as changed, for the review screen. */
export function changedFields(content: ListingContent, live: LiveListing): string[] {
  const fields: string[] = [];
  if (content.title !== live.title) fields.push('title');
  if (content.categoryId !== live.categoryId) fields.push('category');
  if (content.brand !== live.brand || content.brandId !== live.brandId) fields.push('brand');
  if (content.shortDescription !== live.shortDescription) fields.push('shortDescription');
  if (content.description !== live.description) fields.push('description');
  if (content.videoUrl !== live.videoUrl) fields.push('video');
  if (stable(content.attributes ?? []) !== stable(live.attributes ?? [])) fields.push('attributes');
  if (stable(content.highlights ?? []) !== stable(live.highlights ?? [])) fields.push('highlights');
  if (!sameList(content.imageUrls, live.images.map((i) => i.url))) fields.push('images');
  if (content.variantEdits.length > 0) fields.push('variants');
  if (content.newVariants.length > 0) fields.push('newVariants');
  return fields;
}

/**
 * Put an approved edit onto the listing, in one transaction, and close the
 * revision. Pictures are rewritten only where they changed, so their rows
 * (and anything keyed to them) survive an edit that left them alone.
 */
export async function applyRevision(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { images: { orderBy: { sortOrder: 'asc' } }, revision: true },
  });
  if (!product) throw ApiError.notFound('Product not found');
  if (!product.revision || product.revision.status !== 'PENDING') {
    throw ApiError.badRequest('There is no edit waiting for review on this listing', 'NO_PENDING_REVISION');
  }
  const content = product.revision.content as unknown as ListingContent;
  const rules = await categoryRulesFor(content.categoryId);
  const imagesChanged = !sameList(content.imageUrls, product.images.map((i) => i.url));
  // A new category can mean a new GST rate: keep the seller prices (before
  // GST) and reprice for buyers once the edit is live.
  const categoryChanging = content.categoryId !== product.categoryId;
  if (categoryChanging) {
    await recordOrderLineGstRates();
    await ensureSellerPrices({ id: product.id }, true);
  }

  await prisma.$transaction([
    prisma.product.update({
      where: { id: product.id },
      data: {
        title: content.title,
        categoryId: content.categoryId,
        brand: content.brand,
        brandId: content.brandId,
        shortDescription: content.shortDescription,
        description: content.description,
        videoUrl: content.videoUrl,
        attributes: content.attributes as Prisma.InputJsonValue,
        highlights: content.highlights as Prisma.InputJsonValue,
        // A new title or category can make try-on wrong for this listing.
        tryOnEnabled: product.tryOnEnabled && rules.tryOnEligible && !isSensitiveForTryOn(content.title),
      },
    }),
    ...(imagesChanged
      ? [
          prisma.productImage.deleteMany({ where: { productId: product.id } }),
          prisma.productImage.createMany({
            data: content.imageUrls.map((url, i) => ({ productId: product.id, url, altText: content.title, sortOrder: i })),
          }),
        ]
      : []),
    ...content.variantEdits.flatMap((edit) => [
      // Scoped to this product: a variant removed since the edit was made is simply not there.
      prisma.productVariant.updateMany({
        where: { id: edit.id, productId: product.id },
        data: {
          optionValues: edit.optionValues,
          optionsKey: edit.optionsKey,
          label: edit.label,
          size: edit.size,
          color: edit.color,
        },
      }),
      ...(edit.imageUrls
        ? [
            prisma.productVariantImage.deleteMany({ where: { variantId: edit.id, variant: { productId: product.id } } }),
            prisma.productVariantImage.createMany({
              data: edit.imageUrls.map((url, i) => ({ variantId: edit.id, url, altText: content.title, sortOrder: i })),
            }),
          ]
        : []),
    ]),
    ...content.newVariants.map((v) =>
      prisma.productVariant.create({
        data: {
          productId: product.id,
          optionValues: v.optionValues,
          optionsKey: v.optionsKey,
          label: v.label,
          size: v.size,
          color: v.color,
          sku: v.sku || newSku(),
          pricePaise: v.pricePaise,
          mrpPaise: v.mrpPaise,
          sellerPricePaise: v.sellerPricePaise ?? null,
          sellerMrpPaise: v.sellerMrpPaise ?? null,
          stock: v.stock,
          ...(v.imageUrls.length
            ? { images: { create: v.imageUrls.map((url, i) => ({ url, altText: content.title, sortOrder: i })) } }
            : {}),
        },
      }),
    ),
    prisma.productRevision.delete({ where: { productId: product.id } }),
  ]);
  if (categoryChanging) await repriceProducts({ id: product.id });
}
