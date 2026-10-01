// Turn "Try On Me" on for a catalog that was seeded without it.
//
// Why: Product.tryOnEnabled has defaulted to false since migration 20260901
// and the seed never set it, and the seed granted its demo seller no try-on
// credits either. A site seeded after that date — production was — shows the
// button on no fashion product at all, while every gate in the code is right.
//
// What it does: opts in every product whose category chain allows try-on and
// whose garment is not one try-on must refuse, and gives every seller who
// never received the launch offer the same 50 free runs a real signup gets
// (first 100 shops). It only turns things on. Safe to re-run: a second run
// finds nothing to do.
//
// Run with: npm run db:backfill-tryon --workspace=@clowe/api
// On the server: dc exec api npx tsx prisma/backfillTryOn.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { enableTryOnWhereEligible, grantLaunchTryOns } from './seed/tryOnEligibility';

const prisma = new PrismaClient();

async function main() {
  const products = await enableTryOnWhereEligible(prisma);
  console.log(`[tryon] products opted in: ${products.enabled} of ${products.checked} that were off`);

  const sellers = await prisma.sellerProfile.findMany({
    where: { tryOnFreeGrant: false },
    select: { id: true, shopName: true },
  });
  let granted = 0;
  for (const s of sellers) {
    if (await grantLaunchTryOns(prisma, s.id)) {
      granted += 1;
      console.log(`[tryon] 50 free runs granted to ${s.shopName}`);
    }
  }
  console.log(`[tryon] sellers granted: ${granted} of ${sellers.length} without the offer`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
