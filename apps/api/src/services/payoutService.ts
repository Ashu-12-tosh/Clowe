import {
  computeListingEconomics,
  payoutPanBlock,
  payoutPanMessage,
  type CategoryRules,
  type PayoutPanBlock,
  type PlatformSettings,
} from '@clowe/shared';
import { prisma } from '../db';
import { ApiError } from '../utils/ApiError';
import { getSettings } from './settingsService';
import { payoutProvider } from './payouts';
import { ensureLedgerCoversDeliveries, settlementPosition } from './sellerLedgerService';
import { economicsRates } from './economicsRates';
import { categoryRulesMap } from './categoryRules';
import { getSellerKycSummary } from './kyc/sellerKyc';

export { economicsRates };

// ---------------------------------------------------------------------------
// Seller earnings & settlement.
//
// Money is earned on DELIVERY (not on order), held for the return window, then
// paid out net of commission, gateway charges and section 194-O TDS. Every
// settled line carries its payout id, so nothing can be paid twice.
//
// The amounts come from the seller ledger (sellerLedgerService): a delivery
// posts its earning and deductions there, and what is "available" is the sum
// of the cleared entries. The item queries below decide *which lines* a
// payout settles; the ledger decides *how much*. The two agree unless rates
// changed between delivery and payout, in which case the ledger — the rates
// as they stood when the money was earned — is the one that pays.
// ---------------------------------------------------------------------------

export interface FeeBreakdown {
  grossPaise: number;
  commissionPaise: number;
  gatewayPaise: number;
  /** Platform + delivery + closing — the fixed fees. */
  fixedFeesPaise: number;
  feesPaise: number; // commission + gateway + fixed fees
  tdsPaise: number;
  /** GST TCS (s.52). In netPaise, not in feesPaise: like TDS, it is tax. */
  tcsPaise: number;
  netPaise: number;
}

/** A sold line, with the category its GST rate (and so its TDS/TCS base) comes from. */
export interface FeeLine {
  pricePaise: number;
  quantity: number;
  /** The GST rate the line was sold at; null only on lines written outside checkout. */
  gstRatePercent?: number | null;
  product: { categoryId: string };
}

export type TaxRulesByCategory = Map<string, CategoryRules>;

/** The category GST rules for these lines, in one read. */
export function taxRulesFor(lines: FeeLine[]): Promise<TaxRulesByCategory> {
  return categoryRulesMap(lines.map((l) => l.product.categoryId));
}

const EMPTY_FEES: FeeBreakdown = {
  grossPaise: 0,
  commissionPaise: 0,
  gatewayPaise: 0,
  fixedFeesPaise: 0,
  feesPaise: 0,
  tdsPaise: 0,
  tcsPaise: 0,
  netPaise: 0,
};

/**
 * Fees withheld on one line, using the admin's current rates. A thin view
 * over the shared calculator, so a statement, an overview chart and a ledger
 * entry can never show the same line with different deductions. Quantity
 * matters now: the closing fee is per unit, the other fixed fees per line.
 * The category's GST rule is required for the same reason: it sets the
 * ex-GST value TDS and TCS are taken on, exactly as the ledger does.
 */
export function feesFor(line: FeeLine, settings: PlatformSettings, rules: TaxRulesByCategory): FeeBreakdown {
  const e = computeListingEconomics({
    buyerPricePaise: line.pricePaise,
    gstRatePercent: line.gstRatePercent,
    quantity: line.quantity,
    rates: economicsRates(settings),
    taxRules: rules.get(line.product.categoryId),
  });
  const fixedFeesPaise = e.platformFeePaise + e.deliveryFeePaise + e.closingFeePaise + e.gtChargePaise;
  return {
    grossPaise: e.grossPaise,
    commissionPaise: e.commissionPaise,
    gatewayPaise: e.gatewayFeePaise,
    fixedFeesPaise,
    feesPaise: e.commissionPaise + e.gatewayFeePaise + fixedFeesPaise,
    tdsPaise: e.tdsPaise,
    tcsPaise: e.tcsPaise,
    netPaise: e.sellerReceivesPaise,
  };
}

export function sumFees(items: FeeLine[], settings: PlatformSettings, rules: TaxRulesByCategory): FeeBreakdown {
  return items.reduce<FeeBreakdown>((acc, item) => {
    const line = feesFor(item, settings, rules);
    return {
      grossPaise: acc.grossPaise + line.grossPaise,
      commissionPaise: acc.commissionPaise + line.commissionPaise,
      gatewayPaise: acc.gatewayPaise + line.gatewayPaise,
      fixedFeesPaise: acc.fixedFeesPaise + line.fixedFeesPaise,
      feesPaise: acc.feesPaise + line.feesPaise,
      tdsPaise: acc.tdsPaise + line.tdsPaise,
      tcsPaise: acc.tcsPaise + line.tcsPaise,
      netPaise: acc.netPaise + line.netPaise,
    };
  }, EMPTY_FEES);
}

/** Delivered-on or before this instant = out of the return window. */
export function clearedBefore(holdDays: number): Date {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - holdDays);
  return cutoff;
}

/** Delivered lines that have cleared the hold and haven't been paid yet. */
export async function eligibleItems(sellerId: string, holdDays: number) {
  return prisma.orderItem.findMany({
    where: {
      sellerId,
      status: 'DELIVERED',
      payoutId: null,
      deliveredAt: { lte: clearedBefore(holdDays) },
    },
    orderBy: { deliveredAt: 'asc' },
    select: {
      id: true,
      pricePaise: true,
      gstRatePercent: true,
      quantity: true,
      deliveredAt: true,
      title: true,
      product: { select: { categoryId: true } },
      order: { select: { orderNumber: true, paymentMethod: true } },
    },
  });
}

/** Delivered but still inside the return window — earned, not yet payable. */
export async function clearingItems(sellerId: string, holdDays: number) {
  return prisma.orderItem.findMany({
    where: {
      sellerId,
      status: 'DELIVERED',
      payoutId: null,
      deliveredAt: { gt: clearedBefore(holdDays) },
    },
    orderBy: { deliveredAt: 'asc' },
    select: { id: true, pricePaise: true, quantity: true, deliveredAt: true },
  });
}

/**
 * Approved ad spend not yet recovered from a payout. Ads are prepaid from
 * promotion credits now; this only still finds ads booked before that, which
 * carry no spend entry and are recovered the old way.
 */
export async function outstandingAdSpend(sellerId: string) {
  return prisma.ad.findMany({
    where: {
      sellerId,
      payoutId: null,
      status: { in: ['ACTIVE', 'EXPIRED'] },
      ledgerEntries: { none: { type: 'PROMOTION_CREDIT_SPEND' } },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, pricePaise: true, createdAt: true, placement: true },
  });
}

export interface AvailableBalance {
  /** Deductions on the cleared lines at today's rates — for display only. */
  fees: FeeBreakdown;
  /** Cleared ledger balance: net of fees/TDS and penalties, before ad-spend recovery. */
  netPaise: number;
  /** The whole settlement bucket, cleared or not. */
  ledgerBalancePaise: number;
  adjustmentsPaise: number;
  /** What a payout request would actually transfer. */
  payablePaise: number;
  itemCount: number;
  inClearingPaise: number;
  inClearingCount: number;
  /** When the oldest clearing line becomes payable. */
  nextClearingAt: string | null;
}

export async function availableBalance(sellerId: string): Promise<AvailableBalance> {
  const settings = await getSettings();
  // Lines delivered before the ledger existed get their entries on first read.
  await ensureLedgerCoversDeliveries(sellerId);
  const [position, eligible, clearing, ads] = await Promise.all([
    settlementPosition(sellerId, settings.payoutHoldDays),
    eligibleItems(sellerId, settings.payoutHoldDays),
    clearingItems(sellerId, settings.payoutHoldDays),
    outstandingAdSpend(sellerId),
  ]);

  const fees = sumFees(eligible, settings, await taxRulesFor(eligible));
  // Only the ad spend that fits inside this payout is recovered now; the rest
  // waits for the next one rather than pushing the transfer negative.
  const adjustmentsPaise = affordableAdjustments(ads, position.availablePaise).total;

  const oldestClearing = clearing[0]?.deliveredAt ?? null;
  const releaseAt = oldestClearing
    ? new Date(oldestClearing.getTime() + settings.payoutHoldDays * 86400000)
    : null;

  return {
    fees,
    netPaise: position.availablePaise,
    ledgerBalancePaise: position.balancePaise,
    adjustmentsPaise,
    payablePaise: Math.max(0, position.availablePaise - adjustmentsPaise),
    itemCount: eligible.length,
    inClearingPaise: position.clearingPaise,
    inClearingCount: clearing.length,
    nextClearingAt: releaseAt?.toISOString() ?? null,
  };
}

/** Greedily take ad charges that fit within the payable amount. */
function affordableAdjustments(
  ads: { id: string; pricePaise: number }[],
  netPaise: number,
): { ids: string[]; total: number } {
  const ids: string[] = [];
  let total = 0;
  for (const ad of ads) {
    if (total + ad.pricePaise > netPaise) break;
    ids.push(ad.id);
    total += ad.pricePaise;
  }
  return { ids, total };
}

/** PAYOUT-000001, PAYOUT-000002, … across the platform. */
async function nextReference(): Promise<string> {
  const count = await prisma.payout.count();
  return `PAYOUT-${String(count + 1).padStart(6, '0')}`;
}

/**
 * Settle everything currently payable into one payout and send it to the
 * provider. Items and ads are linked inside a transaction, so a concurrent
 * request can't settle the same line twice.
 */
/**
 * Why this seller cannot be paid for want of a verified PAN, or null. Reads
 * the stored checks only: it never calls the KYC provider.
 */
export async function panBlockFor(sellerId: string): Promise<PayoutPanBlock | null> {
  return payoutPanBlock((await getSellerKycSummary(sellerId)).pan);
}

export async function requestPayout(sellerId: string, methodId?: string) {
  // Checked here and not only at the route. This is the one call in the seller
  // API that moves money out, and a suspension exists largely to stop exactly
  // that; making it depend on a middleware staying attached to a router is the
  // arrangement that let a suspended shop keep trading in the first place.
  const seller = await prisma.sellerProfile.findUnique({
    where: { id: sellerId },
    select: { status: true },
  });
  if (!seller) throw ApiError.notFound('Seller not found');
  if (seller.status !== 'APPROVED') {
    throw ApiError.forbidden(
      'Payouts are on hold while your shop is not active.',
      'SELLER_NOT_PAYABLE',
    );
  }

  // TDS is deposited against the PAN, so none is paid without a verified one —
  // whatever the admin accepted at approval.
  const panBlock = await panBlockFor(sellerId);
  if (panBlock) throw ApiError.forbidden(payoutPanMessage(panBlock), panBlock.code);

  const settings = await getSettings();

  const method = methodId
    ? await prisma.sellerPayoutMethod.findFirst({ where: { id: methodId, sellerId } })
    : await prisma.sellerPayoutMethod.findFirst({
        where: { sellerId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      });
  if (!method) {
    throw ApiError.badRequest('Add a payout method before requesting a payout', 'NO_PAYOUT_METHOD');
  }
  if (!method.verified) {
    throw ApiError.badRequest('This payout method is not verified yet', 'METHOD_UNVERIFIED');
  }

  const pending = await prisma.payout.count({
    where: { sellerId, status: { in: ['PENDING', 'PROCESSING'] } },
  });
  if (pending > 0) {
    throw ApiError.badRequest('A payout is already in progress', 'PAYOUT_IN_PROGRESS');
  }

  const eligible = await eligibleItems(sellerId, settings.payoutHoldDays);
  if (eligible.length === 0) {
    throw ApiError.badRequest('No cleared earnings to pay out yet', 'NOTHING_PAYABLE');
  }

  // The ledger says how much: every cleared entry, which is these lines'
  // earnings and deductions plus anything that counts at once (penalties,
  // waivers, reversals). Lines from before the ledger are posted first so
  // nothing eligible is claimed without being paid.
  await ensureLedgerCoversDeliveries(sellerId);
  const position = await settlementPosition(sellerId, settings.payoutHoldDays);
  const ads = await outstandingAdSpend(sellerId);
  const adjustments = affordableAdjustments(ads, position.availablePaise);
  const netPaise = position.availablePaise - adjustments.total;

  if (netPaise < settings.payoutMinPaise) {
    throw ApiError.badRequest(
      `Minimum payout is ₹${Math.round(settings.payoutMinPaise / 100).toLocaleString('en-IN')} — you have ₹${Math.round(netPaise / 100).toLocaleString('en-IN')} available`,
      'BELOW_MINIMUM',
    );
  }

  const stamps = eligible
    .map((i) => i.deliveredAt)
    .filter((d): d is Date => !!d)
    .map((d) => d.getTime());
  const itemIds = eligible.map((i) => i.id);

  const payout = await prisma.$transaction(async (tx) => {
    // The payout row explains itself from the entries it settles, not from a
    // recomputation at today's rates.
    const byType = await tx.sellerLedgerEntry.groupBy({
      by: ['type'],
      where: { orderItemId: { in: itemIds }, bucket: 'SETTLEMENT' },
      _sum: { amountPaise: true },
    });
    const sumOf = (type: string) => byType.find((t) => t.type === type)?._sum.amountPaise ?? 0;
    const grossPaise = sumOf('SALE_EARNING');
    const commissionPaise = -sumOf('COMMISSION');
    const gatewayPaise = -sumOf('GATEWAY_FEE');
    const tdsPaise = -sumOf('TDS');
    const tcsPaise = -sumOf('GST_TCS');

    const created = await tx.payout.create({
      data: {
        reference: await nextReference(),
        sellerId,
        periodFrom: new Date(Math.min(...stamps)),
        periodTo: new Date(Math.max(...stamps)),
        grossPaise,
        commissionPaise,
        gatewayPaise,
        // Whatever else separates gross from net: fixed fees on these lines
        // and penalties or waivers that count at once. Defined as the
        // remainder so the row always reconciles, whichever entries exist.
        otherFeesPaise:
          grossPaise - commissionPaise - gatewayPaise - tdsPaise - tcsPaise - adjustments.total - netPaise,
        adjustmentPaise: adjustments.total,
        tdsPaise,
        tcsPaise,
        netPaise,
        status: 'PROCESSING',
        methodId: method.id,
        methodLabel: describeMethod(method),
      },
    });

    // Claim only lines that are still unsettled — a racing request loses here.
    const claimed = await tx.orderItem.updateMany({
      where: { id: { in: itemIds }, payoutId: null },
      data: { payoutId: created.id },
    });
    if (claimed.count !== itemIds.length) {
      throw ApiError.badRequest('Earnings changed while the payout was being created — try again');
    }
    if (adjustments.ids.length > 0) {
      await tx.ad.updateMany({
        where: { id: { in: adjustments.ids }, payoutId: null },
        data: { payoutId: created.id },
      });
    }
    return created;
  });

  const transfer = await payoutProvider.transfer({
    reference: payout.reference,
    amountPaise: payout.netPaise,
    destination: payout.methodLabel ?? method.label,
    ifsc: method.ifsc,
    upiId: method.upiId,
  });

  if (transfer.status === 'FAILED') {
    // Release the lines so the seller can retry once the issue is fixed.
    await prisma.$transaction([
      prisma.orderItem.updateMany({ where: { payoutId: payout.id }, data: { payoutId: null } }),
      prisma.ad.updateMany({ where: { payoutId: payout.id }, data: { payoutId: null } }),
      prisma.payout.update({
        where: { id: payout.id },
        data: { status: 'FAILED', failureReason: transfer.failureReason ?? 'Transfer failed' },
      }),
    ]);
    throw ApiError.badRequest(transfer.failureReason ?? 'Payout failed', 'PAYOUT_FAILED');
  }

  // The money has left (or is on its way), so the ledger records it now — a
  // FAILED transfer above never reaches here and never touches the ledger.
  // The (payoutId, type) unique pair means a replay cannot post it twice.
  const placements = adjustments.ids.length;
  const [settled] = await prisma.$transaction([
    prisma.payout.update({
      where: { id: payout.id },
      data: {
        status: transfer.status,
        utr: transfer.utr,
        processedAt: transfer.status === 'PAID' ? new Date() : null,
      },
    }),
    prisma.sellerLedgerEntry.createMany({
      data: [
        {
          sellerId,
          type: 'PAYOUT',
          bucket: 'SETTLEMENT',
          amountPaise: -payout.netPaise,
          payoutId: payout.id,
          note: `${payout.reference} to ${payout.methodLabel ?? method.label}`,
        },
        ...(adjustments.total > 0
          ? [
              {
                sellerId,
                type: 'ADJUSTMENT' as const,
                bucket: 'SETTLEMENT' as const,
                amountPaise: -adjustments.total,
                payoutId: payout.id,
                note: `Ad spend recovered with ${payout.reference} (${placements} placement${placements === 1 ? '' : 's'})`,
              },
            ]
          : []),
      ],
      skipDuplicates: true,
    }),
  ]);

  await prisma.notification.create({
    data: {
      userId: (await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } })).userId,
      type: 'PAYOUT_SENT',
      title: 'Payout on its way 💸',
      body: `${settled.reference}: ₹${(settled.netPaise / 100).toLocaleString('en-IN')} sent to ${settled.methodLabel}. UTR ${settled.utr}.`,
      linkHref: '/seller/payouts',
    },
  });

  return settled;
}

export function describeMethod(method: {
  type: string;
  label: string;
  accountLast4: string | null;
  upiId: string | null;
}): string {
  if (method.type === 'UPI') return `${method.label} · ${method.upiId ?? ''}`.trim();
  return `${method.label} ••••${method.accountLast4 ?? '----'}`;
}
