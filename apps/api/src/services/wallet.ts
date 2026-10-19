import type { Prisma, SellerLedgerType } from '@prisma/client';
import { cloweGst } from '@clowe/shared';
import { prisma } from '../db';
import { getCommercial } from './commercial';
import { balance, postEntry } from './sellerLedgerService';

// ---------------------------------------------------------------------------
// The Seller Wallet (owner's Batch 2). Sellers top it up through the payment
// gateway (the PROMOTION bucket, as promotion credits were); Clowe's charges
// — plan, advertising, sponsorship, try-on credits — come from it first, and
// whatever it cannot cover comes off the next payout (the SETTLEMENT bucket).
// Advertising credit (AD_CREDIT: welcome credit, plan credit) is spent first,
// on advertising only, and carries no GST: it is not money paid.
//
// Every charge is exclusive of GST; the GST is posted beside it as
// CLOWE_FEE_GST (chargeType = the charge), and both appear on Clowe's monthly
// tax invoice to the seller. A charge is posted once per idempotency key.
// ---------------------------------------------------------------------------

type Db = Prisma.TransactionClient | typeof prisma;

export type ChargeType = Extract<SellerLedgerType, 'SUBSCRIPTION_FEE' | 'AD_SPEND' | 'SPONSORSHIP_FEE' | 'TRYON_CREDITS'>;

export interface ChargeResult {
  charged: boolean;
  basePaise: number;
  gstPaise: number;
  fromAdCreditPaise: number;
  fromWalletPaise: number;
  fromPayoutPaise: number;
}

export async function walletView(sellerId: string, db: Db = prisma) {
  const [walletPaise, adCreditPaise, settlementPaise] = await Promise.all([
    balance(sellerId, 'PROMOTION', db),
    balance(sellerId, 'AD_CREDIT', db),
    balance(sellerId, 'SETTLEMENT', db),
  ]);
  return { walletPaise, adCreditPaise, settlementPaise };
}

/**
 * Charge a seller. `useAdCredit` lets advertising spend come from ad credit
 * first. `walletOnly` refuses (charges nothing) when the wallet and credit
 * cannot cover it, instead of taking it from the next payout — for things the
 * seller is buying now and can top up for.
 *
 * One charge per seller at a time (an advisory lock around the balance read
 * and the posts): two charges arriving together would otherwise both see the
 * same advertising credit and wallet balance and spend them twice.
 */
export async function chargeSeller(input: {
  sellerId: string;
  type: ChargeType;
  basePaise: number;
  note: string;
  idempotencyKey: string;
  useAdCredit?: boolean;
  walletOnly?: boolean;
  adId?: string | null;
}): Promise<ChargeResult> {
  const { fees } = await getCommercial();
  const nothing: ChargeResult = { charged: false, basePaise: input.basePaise, gstPaise: 0, fromAdCreditPaise: 0, fromWalletPaise: 0, fromPayoutPaise: 0 };
  if (input.basePaise <= 0) return { ...nothing, charged: true };
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seller-charge:${input.sellerId}`}))`;
    return chargeLocked(input, fees, nothing, tx);
  });
}

async function chargeLocked(
  input: Parameters<typeof chargeSeller>[0],
  fees: { gstPercent: number },
  nothing: ChargeResult,
  tx: Prisma.TransactionClient,
): Promise<ChargeResult> {
  const already = await tx.sellerLedgerEntry.findFirst({ where: { idempotencyKey: { startsWith: `${input.idempotencyKey}:` } } });
  if (already) return nothing;

  const { walletPaise, adCreditPaise } = await walletView(input.sellerId, tx);
  const fromCredit = input.useAdCredit ? Math.max(0, Math.min(adCreditPaise, input.basePaise)) : 0;
  const base = input.basePaise - fromCredit;
  const gst = cloweGst(base, fees.gstPercent);
  const total = base + gst;
  const fromWallet = Math.max(0, Math.min(walletPaise, total));
  const fromPayout = total - fromWallet;
  if (input.walletOnly && fromPayout > 0) return { ...nothing, gstPaise: gst };

  // Base and GST each split between the wallet and the payout in proportion.
  const walletBase = total > 0 ? Math.round((fromWallet * base) / total) : 0;
  const walletGst = fromWallet - walletBase;
  const payoutBase = base - walletBase;
  const payoutGst = gst - walletGst;
  const k = input.idempotencyKey;
  const posts: Parameters<typeof postEntry>[0][] = [];
  if (fromCredit > 0) {
    posts.push({ sellerId: input.sellerId, type: input.type, bucket: 'AD_CREDIT', amountPaise: -fromCredit, note: `${input.note} (advertising credit)`, idempotencyKey: `${k}:credit` });
  }
  if (walletBase > 0) posts.push({ sellerId: input.sellerId, type: input.type, bucket: 'PROMOTION', amountPaise: -walletBase, note: input.note, idempotencyKey: `${k}:wallet` });
  if (walletGst > 0) {
    posts.push({ sellerId: input.sellerId, type: 'CLOWE_FEE_GST', bucket: 'PROMOTION', amountPaise: -walletGst, note: `GST ${fees.gstPercent}% — ${input.note}`, taxablePaise: walletBase, chargeType: input.type, idempotencyKey: `${k}:wallet-gst` });
  }
  if (payoutBase > 0) posts.push({ sellerId: input.sellerId, type: input.type, bucket: 'SETTLEMENT', amountPaise: -payoutBase, note: input.note, idempotencyKey: `${k}:payout` });
  if (payoutGst > 0) {
    posts.push({ sellerId: input.sellerId, type: 'CLOWE_FEE_GST', bucket: 'SETTLEMENT', amountPaise: -payoutGst, note: `GST ${fees.gstPercent}% — ${input.note}`, taxablePaise: payoutBase, chargeType: input.type, idempotencyKey: `${k}:payout-gst` });
  }
  for (const p of posts) await postEntry(p, tx);
  return { charged: true, basePaise: input.basePaise, gstPaise: gst, fromAdCreditPaise: fromCredit, fromWalletPaise: fromWallet, fromPayoutPaise: fromPayout };
}

/** Give advertising credit (welcome credit, a plan's monthly credit). Once per key. */
export async function grantAdCredit(sellerId: string, amountPaise: number, note: string, idempotencyKey: string): Promise<boolean> {
  if (amountPaise <= 0) return false;
  return postEntry({ sellerId, type: 'AD_CREDIT_GRANT', bucket: 'AD_CREDIT', amountPaise, note, idempotencyKey });
}

/** Can the wallet (and, for ads, the credit) cover this charge, GST included? */
export async function canCover(sellerId: string, basePaise: number, useAdCredit = false): Promise<boolean> {
  const { fees } = await getCommercial();
  const { walletPaise, adCreditPaise } = await walletView(sellerId);
  const base = Math.max(0, basePaise - (useAdCredit ? adCreditPaise : 0));
  return walletPaise >= base + cloweGst(base, fees.gstPercent);
}

/**
 * Give back a charge (a rejected booking or creative): every entry posted for
 * it, reversed into the bucket it came from — credit back as credit, wallet
 * money to the wallet, a payout deduction undone. Once.
 */
export async function refundCharge(idempotencyKey: string, note: string): Promise<number> {
  const entries = await prisma.sellerLedgerEntry.findMany({ where: { idempotencyKey: { startsWith: `${idempotencyKey}:` } } });
  let refunded = 0;
  await prisma.$transaction(async (tx) => {
    for (const e of entries) {
      if (e.idempotencyKey?.endsWith(':refund')) continue;
      const done = await postEntry(
        {
          sellerId: e.sellerId,
          type: e.type,
          bucket: e.bucket,
          amountPaise: -e.amountPaise,
          note: `Refund — ${note}`,
          chargeType: e.chargeType,
          taxablePaise: e.taxablePaise === null ? null : -e.taxablePaise,
          idempotencyKey: `${e.idempotencyKey}:refund`,
        },
        tx,
      );
      if (done) refunded += -e.amountPaise;
    }
  });
  return refunded;
}
