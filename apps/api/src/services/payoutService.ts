import {
  computeListingEconomics,
  payoutBankBlock,
  payoutGstinVerificationBlock,
  payoutPanBlock,
  payoutVerificationMessage,
  type PayoutBankBlock,
  payoutPanMessage,
  type CategoryRules,
  type PayoutGstinBlock,
  type PayoutPanBlock,
  type PlatformSettings,
  type SellerFeesV2,
} from '@clowe/shared';
import { prisma } from '../db';
import type { Prisma } from '@prisma/client';
import { ApiError } from '../utils/ApiError';
import { recordAudit } from './auditService';
import { bankAccountNumberOf } from './bankAccountCrypto';
import { GatewayError } from './payments/PaymentProvider';
import type { PayoutTransfer } from './payouts/PayoutProvider';
import { getSettings } from './settingsService';
import { payoutProvider } from './payouts';
import { ensureLedgerCoversDeliveries, holdRuleOf, lineClearsAt, settlementPosition, type HoldRule } from './sellerLedgerService';
import { ensureFreightPosted } from './shipping/freight';
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
  /** The commission, or under the Batch 2 fees the referral fee. */
  commissionPaise: number;
  /** The gateway fee, or under the Batch 2 fees the payment collection fee. */
  gatewayPaise: number;
  /** Everything else Clowe charges: platform, closing and GT fees, the handling fee, and the GST on Clowe's fees. */
  fixedFeesPaise: number;
  feesPaise: number; // commission + gateway + fixed fees
  tdsPaise: number;
  /** GST TCS (s.52). In netPaise, not in feesPaise: like TDS, it is tax. */
  tcsPaise: number;
  netPaise: number;
}

/**
 * A sold line, with the category its GST rate (and so its TDS/TCS base) comes
 * from, and the fees it was sold under. The fee fields are required on
 * purpose: a query that leaves them out would show a Batch 2 line with the
 * old commission (pre-launch audit 2026-10-20, H1), so it does not compile.
 */
export interface FeeLine {
  pricePaise: number;
  quantity: number;
  /** The GST rate the line was sold at; null only on lines written outside checkout. */
  gstRatePercent?: number | null;
  /** 2 = the owner's Batch 2 fees, recorded on the line (feeRates); otherwise the earlier model. */
  feeModel: number | null;
  feeRates: Prisma.JsonValue | null;
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
  // The fees the line was sold under, exactly as the ledger posts them.
  const v2 = line.feeModel === 2 && line.feeRates ? (line.feeRates as unknown as SellerFeesV2) : null;
  const e = computeListingEconomics({
    buyerPricePaise: line.pricePaise,
    gstRatePercent: line.gstRatePercent,
    quantity: line.quantity,
    rates: { ...economicsRates(settings), v2 },
    taxRules: rules.get(line.product.categoryId),
  });
  const fixedFeesPaise = e.platformFeePaise + e.closingFeePaise + e.gtChargePaise + e.handlingFeePaise + e.cloweFeeGstPaise;
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
/** A COD line is payable only once Delhivery's remittance for its parcel is matched. */
const remittedOrPrepaid = {
  OR: [{ shipmentId: null }, { shipment: { OR: [{ paymentType: { not: 'COD' } }, { codRemittedAt: { not: null } }] } }],
};

/** The hold the platform settings describe: payoutHoldDays, or a line's return window if longer. */
export function holdRule(settings: PlatformSettings): HoldRule {
  return { holdDays: settings.payoutHoldDays, defaultWindowDays: settings.returnWindowDays };
}

export async function eligibleItems(sellerId: string, hold: number | HoldRule) {
  const rule = holdRuleOf(hold);
  const now = Date.now();
  // Past the hold is necessary; past the line's own return window too.
  const items = await prisma.orderItem.findMany({
    where: {
      sellerId,
      status: 'DELIVERED',
      payoutId: null,
      deliveredAt: { lte: clearedBefore(rule.holdDays) },
      ...remittedOrPrepaid,
    },
    orderBy: { deliveredAt: 'asc' },
    select: {
      id: true,
      pricePaise: true,
      gstRatePercent: true,
      feeModel: true,
      feeRates: true,
      quantity: true,
      deliveredAt: true,
      returnWindowDays: true,
      title: true,
      product: { select: { categoryId: true } },
      order: { select: { orderNumber: true, paymentMethod: true } },
    },
  });
  return items.filter((i) => i.deliveredAt && lineClearsAt(i.deliveredAt, i.returnWindowDays, rule).getTime() <= now);
}

/** Delivered but still inside the hold or its return window — earned, not yet payable. */
export async function clearingItems(sellerId: string, hold: number | HoldRule) {
  const rule = holdRuleOf(hold);
  const now = Date.now();
  const items = await prisma.orderItem.findMany({
    where: { sellerId, status: 'DELIVERED', payoutId: null, deliveredAt: { not: null } },
    orderBy: { deliveredAt: 'asc' },
    select: { id: true, pricePaise: true, quantity: true, deliveredAt: true, returnWindowDays: true },
  });
  return items
    .map((i) => ({ ...i, clearsAt: lineClearsAt(i.deliveredAt!, i.returnWindowDays, rule) }))
    .filter((i) => i.clearsAt.getTime() > now)
    .sort((a, b) => a.clearsAt.getTime() - b.clearsAt.getTime());
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
  /** COD sales waiting for Delhivery's remittance. */
  codAwaitingPaise: number;
}

export async function availableBalance(sellerId: string): Promise<AvailableBalance> {
  const settings = await getSettings();
  // Lines delivered before the ledger existed get their entries on first read,
  // and delivered parcels their freight, before anything is worked out.
  await ensureLedgerCoversDeliveries(sellerId);
  await ensureFreightPosted(sellerId);
  const rule = holdRule(settings);
  const [position, eligible, clearing, ads] = await Promise.all([
    settlementPosition(sellerId, rule),
    eligibleItems(sellerId, rule),
    clearingItems(sellerId, rule),
    outstandingAdSpend(sellerId),
  ]);

  const fees = sumFees(eligible, settings, await taxRulesFor(eligible));
  // Only the ad spend that fits inside this payout is recovered now; the rest
  // waits for the next one rather than pushing the transfer negative.
  const adjustmentsPaise = affordableAdjustments(ads, position.availablePaise).total;

  // The soonest a clearing line becomes payable (they are sorted by it).
  const releaseAt = clearing[0]?.clearsAt ?? null;

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
    codAwaitingPaise: position.codAwaitingPaise,
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
/**
 * No payouts without a GSTIN — the buyer's tax invoice is issued under it —
 * and none until Clowe (an admin, or a real provider) has verified it.
 */
export async function gstinBlockFor(sellerId: string): Promise<PayoutGstinBlock | null> {
  const seller = await prisma.sellerProfile.findUnique({ where: { id: sellerId }, select: { gstNumber: true } });
  if (!seller?.gstNumber?.trim()) {
    return {
      code: 'GSTIN_REQUIRED',
      reason: 'Every tax invoice to your buyers is issued under your GSTIN, and there is none on file.',
      action: 'Add it in Store settings → Business.',
    };
  }
  return payoutGstinVerificationBlock((await getSellerKycSummary(sellerId)).gstin);
}

/** No payouts to a bank account Clowe has not verified (against the cancelled cheque, or by the bank). */
export async function bankBlockFor(sellerId: string): Promise<PayoutBankBlock | null> {
  return payoutBankBlock((await getSellerKycSummary(sellerId)).bank);
}

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

  const gstinBlock = await gstinBlockFor(sellerId);
  if (gstinBlock) throw ApiError.forbidden(`Payouts need your GSTIN. ${gstinBlock.reason} ${gstinBlock.action}`, gstinBlock.code);

  // TDS is deposited against the PAN, so none is paid without a verified one —
  // whatever the admin accepted at approval.
  const panBlock = await panBlockFor(sellerId);
  if (panBlock) throw ApiError.forbidden(payoutPanMessage(panBlock), panBlock.code);
  const bankBlock = await bankBlockFor(sellerId);
  if (bankBlock) throw ApiError.forbidden(payoutVerificationMessage(bankBlock), bankBlock.code);

  const settings = await getSettings();

  // Unless one is chosen: the default if it is verified, else the first verified one.
  const method = methodId
    ? await prisma.sellerPayoutMethod.findFirst({ where: { id: methodId, sellerId } })
    : ((await prisma.sellerPayoutMethod.findFirst({
        where: { sellerId, verified: true },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      })) ??
      (await prisma.sellerPayoutMethod.findFirst({ where: { sellerId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] })));
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

  const rule = holdRule(settings);
  const eligible = await eligibleItems(sellerId, rule);
  if (eligible.length === 0) {
    throw ApiError.badRequest('No cleared earnings to pay out yet', 'NOTHING_PAYABLE');
  }

  // The ledger says how much: every cleared entry, which is these lines'
  // earnings and deductions plus anything that counts at once (penalties,
  // waivers, reversals). Lines from before the ledger are posted first so
  // nothing eligible is claimed without being paid.
  await ensureLedgerCoversDeliveries(sellerId);
  const position = await settlementPosition(sellerId, rule);
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

    const reference = await nextReference();
    const created = await tx.payout.create({
      data: {
        reference,
        transferId: transferIdFor(reference),
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
        status: 'PENDING',
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
    // The money is set aside now, at request: nothing else (a plan renewal, a
    // charge) can spend what is waiting for approval or on its way. A
    // rejected, failed or reversed payout gives it back with one entry.
    // The (payoutId, type) unique pair means a replay cannot post it twice.
    const placements = adjustments.ids.length;
    await tx.sellerLedgerEntry.createMany({
      data: [
        {
          sellerId,
          type: 'PAYOUT',
          bucket: 'SETTLEMENT',
          amountPaise: -netPaise,
          payoutId: created.id,
          note: `${reference} to ${created.methodLabel ?? method.label}`,
        },
        ...(adjustments.total > 0
          ? [
              {
                sellerId,
                type: 'ADJUSTMENT' as const,
                bucket: 'SETTLEMENT' as const,
                amountPaise: -adjustments.total,
                payoutId: created.id,
                note: `Ad spend recovered with ${reference} (${placements} placement${placements === 1 ? '' : 's'})`,
              },
            ]
          : []),
      ],
      skipDuplicates: true,
    });
    return created;
  });

  const userId = (await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId } })).userId;
  if (!settings.payoutAutoApprove) {
    await prisma.notification.create({
      data: {
        userId,
        type: 'PAYOUT_REQUESTED',
        title: 'Payout requested',
        body: `${payout.reference}: ₹${(payout.netPaise / 100).toLocaleString('en-IN')} to ${payout.methodLabel}. Clowe reviews every payout before it is sent — usually within one working day.`,
        linkHref: '/seller/payouts',
      },
    });
    return payout;
  }
  return sendPayout(payout.id);
}

/** Cashfree's transfer_id: our reference with only letters, digits and underscore. */
export function transferIdFor(reference: string): string {
  return reference.replace(/[^A-Za-z0-9_]/g, '_');
}

const PAYOUT_INCLUDE = {
  method: true,
  seller: { select: { id: true, userId: true, shopName: true, bankAccountNo: true, bankAccountEnc: true, bankIfsc: true, bankAccountName: true, user: { select: { phone: true, email: true } } } },
} as const;

/** The beneficiary id at the provider for a payout method: one per method. */
function beneficiaryIdFor(methodId: string): string {
  return `CLWB_${methodId}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);
}

/**
 * Hand an approved (or auto-approved) PENDING payout to the payout provider.
 * Claimed first (PENDING → PROCESSING) so a double click sends it once; the
 * transfer id is fixed per payout, so even a resend after a timeout is the
 * same transfer at the provider, never a second one.
 */
export async function sendPayout(payoutId: string) {
  const claim = await prisma.payout.updateMany({ where: { id: payoutId, status: 'PENDING' }, data: { status: 'PROCESSING' } });
  if (claim.count === 0) return prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
  return transferPayout(payoutId);
}

/** Send a PROCESSING payout's transfer (again, with the same id) and apply the answer. */
async function transferPayout(payoutId: string) {
  const payout = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId }, include: PAYOUT_INCLUDE });
  const method = payout.method;
  const transferId = payout.transferId ?? transferIdFor(payout.reference);
  if (!method) {
    await failPayout(payout.id, 'The payout method was removed before the transfer was sent');
    return prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
  }

  let beneficiaryId = method.beneficiaryId;
  try {
    if (payoutProvider.ensureBeneficiary && !beneficiaryId) {
      // The full account number lives (encrypted) on the seller's KYC record;
      // a payout method is that account once verified. Never anything else.
      const accountNumber = method.type === 'BANK' ? bankAccountNumberOf(payout.seller) : null;
      if (method.type === 'BANK' && (!accountNumber || accountNumber.slice(-4) !== method.accountLast4 || (payout.seller.bankIfsc ?? '').toUpperCase() !== (method.ifsc ?? '').toUpperCase())) {
        await failPayout(payout.id, 'The verified bank account on file no longer matches this payout method — verify it again');
        return prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
      }
      beneficiaryId = await payoutProvider.ensureBeneficiary({
        id: beneficiaryIdFor(method.id),
        name: method.accountName || payout.seller.bankAccountName || payout.seller.shopName,
        accountNumber,
        ifsc: method.ifsc,
        vpa: method.type === 'UPI' ? method.upiId : null,
        phone: payout.seller.user.phone,
        email: payout.seller.user.email,
      });
      await prisma.sellerPayoutMethod.update({ where: { id: method.id }, data: { beneficiaryId } });
    }
    const transfer = await payoutProvider.transfer({
      transferId,
      reference: payout.reference,
      amountPaise: payout.netPaise,
      destination: payout.methodLabel ?? method.label,
      beneficiaryId,
      mode: method.type === 'UPI' ? 'upi' : 'banktransfer',
      ifsc: method.ifsc,
      upiId: method.upiId,
    });
    await applyTransfer(payout.id, transfer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Transfer failed';
    console.error(`[clowe-api] payout ${payout.reference}:`, message);
    if (err instanceof GatewayError && err.uncertain) {
      // It may have been received: leave it PROCESSING; the poller asks the
      // provider by transfer id and resends only if it never arrived.
      await prisma.payout.update({ where: { id: payout.id }, data: { providerStatus: 'UNCONFIRMED' } });
    } else {
      await failPayout(payout.id, message);
    }
  }
  return prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
}

/** Apply what the provider says about a payout's transfer. Idempotent. */
async function applyTransfer(payoutId: string, transfer: PayoutTransfer): Promise<void> {
  const known = {
    providerTransferId: transfer.providerTransferId ?? undefined,
    providerStatus: transfer.providerStatus ?? undefined,
  };
  if (transfer.status === 'PAID') {
    const paid = await prisma.payout.updateMany({
      where: { id: payoutId, status: 'PROCESSING' },
      data: { ...known, status: 'PAID', utr: transfer.utr ?? null, processedAt: new Date(), failureReason: null },
    });
    if (paid.count === 1) {
      const settled = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId }, include: { seller: { select: { userId: true } } } });
      await prisma.notification.create({
        data: {
          userId: settled.seller.userId,
          type: 'PAYOUT_SENT',
          title: 'Payout on its way 💸',
          body: `${settled.reference}: ₹${(settled.netPaise / 100).toLocaleString('en-IN')} sent to ${settled.methodLabel}.${settled.utr ? ` UTR ${settled.utr}.` : ''}`,
          linkHref: '/seller/payouts',
        },
      });
    }
    return;
  }
  if (transfer.status === 'FAILED') {
    await failPayout(payoutId, transfer.failureReason ?? 'Transfer failed', known.providerStatus);
    return;
  }
  if (transfer.status === 'REVERSED') {
    await reversePayout(payoutId, transfer.failureReason ?? 'Reversed by the bank', known.providerStatus);
    return;
  }
  await prisma.payout.updateMany({ where: { id: payoutId, status: 'PROCESSING' }, data: known });
}

/**
 * Give a payout's money back to the seller's balance and free its lines and
 * ad recoveries to be paid again: for a rejected, failed or reversed payout.
 * One ledger entry undoes the PAYOUT and ADJUSTMENT entries posted at request.
 */
async function releasePayout(
  tx: Prisma.TransactionClient,
  payout: { id: string; sellerId: string; reference: string; netPaise: number; adjustmentPaise: number },
  why: string,
): Promise<void> {
  await tx.orderItem.updateMany({ where: { payoutId: payout.id }, data: { payoutId: null } });
  await tx.ad.updateMany({ where: { payoutId: payout.id }, data: { payoutId: null } });
  const posted = await tx.sellerLedgerEntry.aggregate({
    where: { payoutId: payout.id, type: { in: ['PAYOUT', 'ADJUSTMENT'] } },
    _sum: { amountPaise: true },
  });
  const back = -(posted._sum.amountPaise ?? 0);
  if (back !== 0) {
    await tx.sellerLedgerEntry.createMany({
      data: [
        {
          sellerId: payout.sellerId,
          type: 'ADJUSTMENT',
          bucket: 'SETTLEMENT',
          amountPaise: back,
          idempotencyKey: `payout-release:${payout.id}`,
          note: `${payout.reference} ${why} — the amount is back in your balance`,
        },
      ],
      skipDuplicates: true,
    });
  }
}

async function failPayout(payoutId: string, reason: string, providerStatus?: string): Promise<void> {
  const payout = await prisma.payout.findUnique({ where: { id: payoutId }, include: { seller: { select: { userId: true } } } });
  if (!payout) return;
  const done = await prisma.$transaction(async (tx) => {
    const claim = await tx.payout.updateMany({
      where: { id: payoutId, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'FAILED', failureReason: reason.slice(0, 500), ...(providerStatus ? { providerStatus } : {}) },
    });
    if (claim.count === 0) return false;
    await releasePayout(tx, payout, 'failed');
    return true;
  });
  if (!done) return;
  await prisma.notification.create({
    data: {
      userId: payout.seller.userId,
      type: 'PAYOUT_FAILED',
      title: 'Payout could not be sent',
      body: `${payout.reference} failed: ${reason.slice(0, 160)}. The amount is back in your balance — check your bank details and request it again.`,
      linkHref: '/seller/payouts',
    },
  });
  await recordAudit({
    actorRole: 'SYSTEM',
    module: 'PAYOUTS',
    action: 'Payout failed',
    entityType: 'Payout',
    entityId: payoutId,
    summary: `${payout.reference} (₹${(payout.netPaise / 100).toFixed(2)}) failed: ${reason.slice(0, 200)}`,
    severity: 'HIGH',
    status: 'FAILED',
  });
}

/** The bank sent a paid (or in-flight) transfer back. */
async function reversePayout(payoutId: string, reason: string, providerStatus?: string): Promise<void> {
  const payout = await prisma.payout.findUnique({ where: { id: payoutId }, include: { seller: { select: { userId: true } } } });
  if (!payout) return;
  const done = await prisma.$transaction(async (tx) => {
    const claim = await tx.payout.updateMany({
      where: { id: payoutId, status: { in: ['PROCESSING', 'PAID'] } },
      data: { status: 'REVERSED', reversedAt: new Date(), failureReason: reason.slice(0, 500), ...(providerStatus ? { providerStatus } : {}) },
    });
    if (claim.count === 0) return false;
    await releasePayout(tx, payout, 'was returned by the bank');
    return true;
  });
  if (!done) return;
  await prisma.notification.create({
    data: {
      userId: payout.seller.userId,
      type: 'PAYOUT_FAILED',
      title: 'Payout returned by the bank',
      body: `${payout.reference} (₹${(payout.netPaise / 100).toLocaleString('en-IN')}) was returned by your bank: ${reason.slice(0, 160)}. The amount is back in your balance.`,
      linkHref: '/seller/payouts',
    },
  });
  await recordAudit({
    actorRole: 'SYSTEM',
    module: 'PAYOUTS',
    action: 'Payout reversed',
    entityType: 'Payout',
    entityId: payoutId,
    summary: `${payout.reference} (₹${(payout.netPaise / 100).toFixed(2)}) reversed by the bank: ${reason.slice(0, 200)}`,
    severity: 'CRITICAL',
  });
}

/** An admin approves a PENDING payout: it is sent now. */
export async function approvePayout(payoutId: string, adminId: string) {
  const payout = await prisma.payout.findUnique({ where: { id: payoutId }, select: { status: true, sellerId: true } });
  if (!payout) throw ApiError.notFound('Payout not found');
  if (payout.status !== 'PENDING') throw ApiError.badRequest(`This payout is ${payout.status.toLowerCase()}, not waiting for approval`, 'PAYOUT_NOT_PENDING');
  // The checks that applied at request still apply at approval: a seller
  // suspended, or whose bank account changed, in between is not paid.
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: payout.sellerId }, select: { status: true } });
  if (seller.status !== 'APPROVED') throw ApiError.badRequest('The seller is not active — reject this payout instead', 'SELLER_NOT_PAYABLE');
  const block = (await panBlockFor(payout.sellerId)) ?? (await bankBlockFor(payout.sellerId)) ?? (await gstinBlockFor(payout.sellerId));
  if (block) throw ApiError.badRequest(`Not payable now: ${block.reason}`, block.code);
  const marked = await prisma.payout.updateMany({
    where: { id: payoutId, status: 'PENDING' },
    data: { reviewedById: adminId, reviewedAt: new Date() },
  });
  if (marked.count === 0) throw ApiError.badRequest('This payout was just handled by someone else', 'PAYOUT_NOT_PENDING');
  return sendPayout(payoutId);
}

/** An admin rejects a PENDING payout: nothing is sent and the money is back in the seller's balance. */
export async function rejectPayout(payoutId: string, adminId: string, reason: string) {
  const payout = await prisma.payout.findUnique({ where: { id: payoutId }, include: { seller: { select: { userId: true } } } });
  if (!payout) throw ApiError.notFound('Payout not found');
  const done = await prisma.$transaction(async (tx) => {
    const claim = await tx.payout.updateMany({
      where: { id: payoutId, status: 'PENDING' },
      data: { status: 'REJECTED', reviewedById: adminId, reviewedAt: new Date(), rejectionReason: reason },
    });
    if (claim.count === 0) return false;
    await releasePayout(tx, payout, 'was not approved');
    return true;
  });
  if (!done) throw ApiError.badRequest('This payout is no longer waiting for approval', 'PAYOUT_NOT_PENDING');
  await prisma.notification.create({
    data: {
      userId: payout.seller.userId,
      type: 'PAYOUT_FAILED',
      title: 'Payout not approved',
      body: `${payout.reference} (₹${(payout.netPaise / 100).toLocaleString('en-IN')}) was not approved: ${reason}. The amount is back in your balance.`,
      linkHref: '/seller/payouts',
    },
  });
  return prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
}

/**
 * Ask the provider about a PROCESSING payout and apply the answer: the payout
 * webhook and the poller both end here. A transfer the provider never
 * received is sent again under the same transfer id.
 */
export async function syncPayout(payoutId: string): Promise<void> {
  const payout = await prisma.payout.findUnique({ where: { id: payoutId } });
  if (!payout || !payoutProvider.getTransfer) return;
  // A PAID one is asked about too when a webhook says so: it may be a reversal.
  if (payout.status !== 'PROCESSING' && payout.status !== 'PAID') return;
  await prisma.payout.update({ where: { id: payoutId }, data: { lastCheckedAt: new Date() } });
  const transfer = await payoutProvider.getTransfer(payout.transferId ?? transferIdFor(payout.reference));
  if (transfer) {
    await applyTransfer(payoutId, transfer);
    return;
  }
  if (payout.status === 'PROCESSING') await transferPayout(payoutId);
}

/** The payout behind a provider transfer id. */
export async function payoutByTransferId(transferId: string): Promise<string | null> {
  const payout = await prisma.payout.findUnique({ where: { transferId }, select: { id: true } });
  return payout?.id ?? null;
}

const PAYOUT_POLL_MS = 15 * 60 * 1000;
const PAYOUT_RECHECK_MS = 10 * 60 * 1000;

export async function pollProcessingPayouts(now: Date = new Date()): Promise<number> {
  if (!payoutProvider.getTransfer) return 0;
  const stale = new Date(now.getTime() - PAYOUT_RECHECK_MS);
  const due = await prisma.payout.findMany({
    where: { status: 'PROCESSING', OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: stale } }] },
    select: { id: true },
    orderBy: { requestedAt: 'asc' },
    take: 100,
  });
  for (const p of due) {
    try {
      await syncPayout(p.id);
    } catch (err) {
      console.error(`[clowe-api] payout poll ${p.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return due.length;
}

export function startPayoutPoller(): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    pollProcessingPayouts()
      .catch((err) => console.error('[clowe-api] payout poll failed:', err))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(run, PAYOUT_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
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
