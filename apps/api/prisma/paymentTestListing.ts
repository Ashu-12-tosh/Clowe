/**
 * One-off: the owner's ₹10 live payment test (Cashfree go-live).
 *
 *   dc exec api npx tsx prisma/paymentTestListing.ts                       # dry run: what would be created
 *   dc exec api npx tsx prisma/paymentTestListing.ts --apply               # create it
 *   dc exec api npx tsx prisma/paymentTestListing.ts --deactivate          # dry run: what would be archived
 *   dc exec api npx tsx prisma/paymentTestListing.ts --deactivate --apply  # archive it
 *
 * Creates, on the owner's own account (ADMIN_PHONE, or --phone=…), a seller
 * profile "Clowe Payment Test" at the company's registered address, and one
 * listing at ₹10 (GST included) with stock 1, titled so nobody mistakes it for
 * a product. The user's role is not touched (it stays ADMIN). Admin and
 * seller accounts cannot buy anything, so the purchase is made from a
 * customer account an admin has marked as a test account (Admin → Users):
 * while the store is closed for orders, nobody else can buy it. It is
 * archived right after the test. Idempotent: an existing profile or listing
 * is reused, never duplicated.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const deactivate = process.argv.includes('--deactivate');
const phoneArg = process.argv.find((a) => a.startsWith('--phone='))?.slice('--phone='.length);
const PHONE = phoneArg ?? process.env.ADMIN_PHONE ?? '';
const CATEGORY = process.argv.find((a) => a.startsWith('--category='))?.slice('--category='.length) ?? 'books-academic';
const SLUG = 'clowe-payment-test-not-for-sale';
const SKU = 'CLOWE-PAYMENT-TEST-10';
const PRICE_PAISE = 1_000; // ₹10, GST included
const SHOP = 'Clowe Payment Test';

async function main() {
  if (!/^[6-9]\d{9}$/.test(PHONE)) throw new Error('Give the owner phone: --phone=XXXXXXXXXX (or set ADMIN_PHONE)');
  const user = await prisma.user.findUnique({ where: { phone: PHONE }, select: { id: true, role: true, name: true } });
  if (!user) throw new Error(`No user with phone ${PHONE}`);
  if (user.role !== 'ADMIN') throw new Error(`The owner account must be an admin (it is ${user.role}) — refusing`);
  const store = await prisma.platformSetting.findUnique({ where: { key: 'storeOpenForOrders' } });
  const storeOpen = store?.value === true;
  const existingProduct = await prisma.product.findUnique({ where: { slug: SLUG }, include: { variants: true } });
  const existingSeller = await prisma.sellerProfile.findUnique({ where: { userId: user.id } });

  if (deactivate) {
    console.log(`[payment-test] listing: ${existingProduct ? `${existingProduct.status}, stock ${existingProduct.variants.map((v) => v.stock).join('/')}` : 'none'}`);
    if (!existingProduct) return;
    if (!apply) {
      console.log('[payment-test] Dry run: --apply would archive the listing and set its stock to 0.');
      return;
    }
    await prisma.$transaction([
      prisma.product.update({ where: { id: existingProduct.id }, data: { status: 'ARCHIVED' } }),
      prisma.productVariant.updateMany({ where: { productId: existingProduct.id }, data: { stock: 0 } }),
    ]);
    console.log('[payment-test] Archived: the listing is off the storefront and cannot be bought.');
    return;
  }

  const legal = (await prisma.platformSetting.findUnique({ where: { key: 'legalEntity' } }))?.value as { registeredAddress?: string } | null;
  const pin = legal?.registeredAddress?.match(/\b(\d{6})\b/)?.[1];
  if (!legal?.registeredAddress || pin !== '110043') throw new Error('The registered address on file is not the New Delhi 110043 one this script expects — refusing');
  const category = await prisma.category.findFirst({ where: { slug: CATEGORY, isActive: true } });
  if (!category) throw new Error(`Category ${CATEGORY} not found (pass --category=<slug>)`);

  console.log(`[payment-test] owner: ${user.name ?? 'admin'} (${user.role}) — role stays ${user.role}`);
  console.log(`[payment-test] store open for orders: ${storeOpen ? 'YES' : 'no'} (stays as it is)`);
  console.log(`[payment-test] seller profile: ${existingSeller ? `exists (${existingSeller.shopName}, ${existingSeller.status}) — reused` : `create "${SHOP}", APPROVED, at the registered address (New Delhi 110043)`}`);
  console.log(`[payment-test] listing: ${existingProduct ? `exists (${existingProduct.status}, ${existingProduct.isVisible ? 'visible' : 'hidden'}, ${existingProduct.testOnly ? 'test-only' : 'NOT test-only'}) — reused, set APPROVED + visible + test-only` : `create "Payment test — not for sale" in ${category.slug}, ₹${PRICE_PAISE / 100} GST incl., stock 1, test-only`}`);
  console.log('[payment-test] test-only: in no list, search or sitemap; opens by direct link; only test accounts can buy it');
  console.log(`[payment-test] link: /products/${SLUG}`);
  if (!apply) {
    console.log('[payment-test] Dry run: nothing written. Run again with --apply.');
    return;
  }

  const seller =
    existingSeller ??
    (await prisma.sellerProfile.create({
      data: {
        userId: user.id,
        shopName: SHOP,
        slug: 'clowe-payment-test',
        description: 'Internal account for testing payments. Not a real shop.',
        status: 'APPROVED',
        approvedAt: new Date(),
        addressLine1: 'H. No. 22-A, Ground Floor, Pole 43, Surakh Pur Road, Gali No. 21, Najafgarh',
        city: 'New Delhi',
        state: 'Delhi',
        pincode: '110043',
        pickupLine1: 'H. No. 22-A, Ground Floor, Pole 43, Surakh Pur Road, Gali No. 21, Najafgarh',
        pickupCity: 'New Delhi',
        pickupState: 'Delhi',
        pickupPincode: '110043',
      },
    }));
  if (existingProduct) {
    await prisma.$transaction([
      prisma.product.update({ where: { id: existingProduct.id }, data: { status: 'APPROVED', approvedAt: new Date(), isVisible: true, testOnly: true } }),
      prisma.productVariant.updateMany({ where: { productId: existingProduct.id }, data: { stock: 1 } }),
    ]);
  } else {
    await prisma.product.create({
      data: {
        sellerId: seller.id,
        categoryId: category.id,
        title: 'Payment test — not for sale',
        slug: SLUG,
        description: 'Internal listing used once to test live payments. It is not a product and cannot be bought by shoppers.',
        basePricePaise: PRICE_PAISE,
        status: 'APPROVED',
        approvedAt: new Date(),
        // Never listed anywhere; reachable by its link, bought only by a test account.
        testOnly: true,
        variants: { create: { optionValues: {}, optionsKey: '', label: '', size: '', color: '', sku: SKU, pricePaise: PRICE_PAISE, stock: 1 } },
      },
    });
  }
  console.log(`[payment-test] Created: /products/${SLUG} — ₹${PRICE_PAISE / 100}, stock 1.`);
}

main()
  .catch((err) => {
    console.error('[payment-test]', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
