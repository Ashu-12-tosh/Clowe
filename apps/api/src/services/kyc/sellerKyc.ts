import { createHmac } from 'node:crypto';
import type { SellerKycCheck, SellerKycReview, SellerKycStatus, SellerProfile } from '@prisma/client';
import {
  BANK_ACCOUNT_PATTERN,
  GSTIN_PATTERN,
  IFSC_PATTERN,
  KYC_CHECK_TYPES,
  PAN_PATTERN,
  normalizeTaxId,
  panFromGstin,
  panGstinMismatch,
  type KycCheckType,
  type KycCheckView,
  type KycReason,
  type SellerKycSummary,
} from '@clowe/shared';
import { prisma } from '../../db';
import { kycFingerprintSecret } from '../../env';
import { ApiError } from '../../utils/ApiError';
import { bankAccountNumberOf } from '../bankAccountCrypto';
import { getSettings } from '../settingsService';
import { kycProvider } from './index';
import { KycProviderError, type KycResult } from './KycProvider';

/**
 * Seller KYC: what to verify, what not to pay for twice, and what the admin
 * sees.
 *
 * Every provider call costs money, so the rules here are mostly about not
 * making one:
 *
 *   A PAN or GSTIN that verified is never verified again.
 *   A FAILED answer is not asked again either — the same details would get
 *     the same answer, and the same bill.
 *   A bank account is re-verified only when the account on file changes (or
 *     when a name has appeared for one that was checked without one).
 *   ERROR — no answer — caches nothing, and nothing retries it on its own.
 *     The seller or an admin presses the button again.
 *
 * "The same details" is decided by fingerprint: an HMAC of the PAN, GSTIN, or
 * account number + IFSC, so the verification rows never hold a second copy of
 * the number itself.
 */

type KycFields = Pick<
  SellerProfile,
  'id' | 'panNumber' | 'panName' | 'gstNumber' | 'bankAccountNo' | 'bankAccountEnc' | 'bankIfsc' | 'bankAccountName'
>;

const KYC_FIELDS = {
  id: true,
  panNumber: true,
  panName: true,
  gstNumber: true,
  bankAccountNo: true,
  bankAccountEnc: true,
  bankIfsc: true,
  bankAccountName: true,
} as const;

/**
 * No real provider (the mock): every check is decided by an admin against the
 * documents. A mock answer is never "Verified", in any environment.
 */
const MOCK = 'mock';
export const reviewMode = (): 'MANUAL' | 'PROVIDER' => (kycProvider.name === MOCK ? 'MANUAL' : 'PROVIDER');

/** A crashed run's claim is taken over after this. Three 15s calls fit well inside it. */
const CLAIM_STALE_MS = 2 * 60 * 1000;

/** Another verification for this seller is already running. */
export class KycCheckRunningError extends Error {
  constructor() {
    super('A verification for this seller is already running');
    this.name = 'KycCheckRunningError';
  }
}

// ---------------------------------------------------------------------------
// What is on file, and whether it can be checked
// ---------------------------------------------------------------------------

function fingerprint(label: string, value: string): string {
  return createHmac('sha256', kycFingerprintSecret).update(`${label}:${value}`).digest('hex');
}

function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Something to send to the provider, and the fingerprints to file it under. */
interface Checkable {
  subject: string;
  /** The name to match, or null for validity only. */
  name: string | null;
  nameSubject: string | null;
  call: () => Promise<KycResult>;
}

/** Why a check cannot be sent at all. */
interface NotCheckable {
  state: 'NOT_PROVIDED' | 'INVALID_FORMAT' | 'NOT_RUN';
  reason: KycReason | null;
}

function checkableFor(kind: KycCheckType, seller: KycFields): Checkable | NotCheckable {
  switch (kind) {
    case 'PAN': {
      if (!seller.panNumber?.trim()) return { state: 'NOT_PROVIDED', reason: null };
      const pan = normalizeTaxId(seller.panNumber);
      if (!PAN_PATTERN.test(pan)) return { state: 'INVALID_FORMAT', reason: null };
      const name = seller.panName?.trim();
      // Cashfree can check a PAN without a name, but then the check says
      // nothing about whether the PAN is this seller's. Not worth the fee.
      if (!name) return { state: 'NOT_RUN', reason: 'NAME_MISSING' };
      return {
        subject: fingerprint('PAN', pan),
        name,
        nameSubject: fingerprint('NAME', nameKey(name)),
        call: () => kycProvider.verifyPAN(pan, name),
      };
    }
    case 'GSTIN': {
      // Optional: sellers under the registration threshold have none, and that
      // must never hold up onboarding.
      if (!seller.gstNumber?.trim()) return { state: 'NOT_PROVIDED', reason: null };
      const gstin = normalizeTaxId(seller.gstNumber);
      if (!GSTIN_PATTERN.test(gstin)) return { state: 'INVALID_FORMAT', reason: null };
      return {
        subject: fingerprint('GSTIN', gstin),
        name: null,
        nameSubject: null,
        call: () => kycProvider.verifyGSTIN(gstin),
      };
    }
    case 'BANK': {
      const number = bankAccountNumberOf(seller);
      if (!number || !seller.bankIfsc?.trim()) {
        return { state: 'NOT_PROVIDED', reason: null };
      }
      const account = normalizeTaxId(number);
      const ifsc = normalizeTaxId(seller.bankIfsc);
      if (!BANK_ACCOUNT_PATTERN.test(account) || !IFSC_PATTERN.test(ifsc)) {
        return { state: 'INVALID_FORMAT', reason: null };
      }
      const name = seller.bankAccountName?.trim() || null;
      return {
        subject: fingerprint('BANK', `${account}:${ifsc}`),
        name,
        nameSubject: name ? fingerprint('NAME', nameKey(name)) : null,
        call: () => kycProvider.verifyBank(account, ifsc, name),
      };
    }
  }
}

function isCheckable(c: Checkable | NotCheckable): c is Checkable {
  return 'call' in c;
}

/**
 * The fingerprint of what an admin decides on: the PAN, the GSTIN, or account
 * number + IFSC. Null when there is nothing valid on file to decide on. (A PAN
 * without the name on it can still be checked by an admin against the card.)
 */
export function reviewSubjectFor(kind: KycCheckType, seller: KycFields): string | null {
  switch (kind) {
    case 'PAN': {
      const pan = seller.panNumber ? normalizeTaxId(seller.panNumber) : '';
      return PAN_PATTERN.test(pan) ? fingerprint('PAN', pan) : null;
    }
    case 'GSTIN': {
      const gstin = seller.gstNumber ? normalizeTaxId(seller.gstNumber) : '';
      return GSTIN_PATTERN.test(gstin) ? fingerprint('GSTIN', gstin) : null;
    }
    case 'BANK': {
      const number = bankAccountNumberOf(seller);
      const account = number ? normalizeTaxId(number) : '';
      const ifsc = seller.bankIfsc ? normalizeTaxId(seller.bankIfsc) : '';
      return BANK_ACCOUNT_PATTERN.test(account) && IFSC_PATTERN.test(ifsc) ? fingerprint('BANK', `${account}:${ifsc}`) : null;
    }
  }
}

/** The latest answer (VERIFIED or FAILED) and the latest error, for one subject. */
function historyFor(kind: KycCheckType, subject: string, rows: SellerKycCheck[]) {
  // rows arrive newest first
  const mine = rows.filter((r) => r.kind === kind && r.subject === subject);
  return {
    answer: mine.find((r) => r.outcome !== 'ERROR') ?? null,
    lastError: mine.find((r) => r.outcome === 'ERROR') ?? null,
  };
}

/** Whether this check needs a provider call now. */
function needsCall(kind: KycCheckType, target: Checkable, rows: SellerKycCheck[]): boolean {
  const { answer } = historyFor(kind, target.subject, rows);
  if (!answer) return true; // never answered, or only errors so far
  // A bank account checked without a name, now that there is one: the match
  // is what proves the account is the seller's, so it is worth paying for.
  if (kind === 'BANK' && answer.outcome === 'VERIFIED' && answer.nameScore === null && target.name) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Running checks
// ---------------------------------------------------------------------------

async function loadSeller(sellerId: string): Promise<KycFields> {
  return prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId }, select: KYC_FIELDS });
}

/** This provider's rows only — a mock "verified" must not stand once Cashfree is on. */
async function loadChecks(sellerId: string): Promise<SellerKycCheck[]> {
  return prisma.sellerKycCheck.findMany({
    where: { sellerId, provider: kycProvider.name },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * One run per seller at a time. The claim is a conditional update, so it holds
 * across API instances, and a crashed run's claim goes stale rather than
 * locking the seller out.
 */
async function claim(sellerId: string): Promise<boolean> {
  const now = new Date();
  const { count } = await prisma.sellerProfile.updateMany({
    where: {
      id: sellerId,
      OR: [
        { kycCheckStartedAt: null },
        { kycCheckStartedAt: { lt: new Date(now.getTime() - CLAIM_STALE_MS) } },
      ],
    },
    data: { kycCheckStartedAt: now },
  });
  return count === 1;
}

async function release(sellerId: string): Promise<void> {
  await prisma.sellerProfile.update({ where: { id: sellerId }, data: { kycCheckStartedAt: null } });
}

/**
 * Verify whatever is unsettled, and nothing else. `only` narrows it to named
 * checks — the admin's "re-run this one".
 *
 * Checks run one after another, not in parallel, and an account-level error
 * (bad credentials, no balance) stops the run: the rest would fail the same way.
 */
export async function runSellerKyc(sellerId: string, only?: KycCheckType[]): Promise<SellerKycSummary> {
  if (!(await claim(sellerId))) throw new KycCheckRunningError();
  try {
    const seller = await loadSeller(sellerId);
    const rows = await loadChecks(sellerId);

    for (const kind of KYC_CHECK_TYPES) {
      if (only && !only.includes(kind)) continue;
      const target = checkableFor(kind, seller);
      if (!isCheckable(target) || !needsCall(kind, target, rows)) continue;

      const base = {
        sellerId,
        kind,
        provider: kycProvider.name,
        subject: target.subject,
        nameSubject: target.nameSubject,
      };
      try {
        const result = await target.call();
        await prisma.sellerKycCheck.create({
          data: {
            ...base,
            outcome: result.status,
            reason: result.reason,
            nameScore: result.nameMatch?.score ?? null,
            nameBand: result.nameMatch?.band ?? null,
          },
        });
      } catch (err) {
        const reason = err instanceof KycProviderError ? err.reason : 'PROVIDER_UNAVAILABLE';
        await prisma.sellerKycCheck.create({ data: { ...base, outcome: 'ERROR', reason } });
        // Status and error code only: request fields are PANs and account numbers.
        const detail = err instanceof KycProviderError ? err.detail : err instanceof Error ? err.name : 'unknown';
        console.error(`[clowe-api] KYC ${kind} check for seller ${sellerId} did not complete: ${reason} (${detail})`);
        if (reason === 'PROVIDER_AUTH' || reason === 'PROVIDER_BALANCE') break;
      }
    }
  } finally {
    await release(sellerId);
  }
  return getSellerKycSummary(sellerId);
}

/** Provider checks a seller's own edits may start in a day; past it, the Verify button and admins still can. */
export const AUTO_KYC_DAILY_CHECKS = 6;

/**
 * Verify a seller's details on their own, without anyone pressing a button:
 * when they apply, and when they change their PAN, GSTIN or bank account.
 * Only with a real provider (with the mock an admin decides every check), in
 * the background (the seller's request never waits on Cashfree), and within
 * a daily allowance — each changed detail is a new paid check, so a seller
 * re-typing an account number over and over must not run up the bill. What
 * was verified before is never paid for again (the fingerprint cache), and
 * whatever cannot be verified stays with the admin review as before.
 */
export function autoVerifySellerKyc(sellerId: string, only?: KycCheckType[]): void {
  if (reviewMode() !== 'PROVIDER') return;
  void (async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const today = await prisma.sellerKycCheck.count({ where: { sellerId, provider: kycProvider.name, createdAt: { gte: since } } });
    if (today >= AUTO_KYC_DAILY_CHECKS) {
      console.warn(`[clowe-api] KYC: automatic checks for seller ${sellerId} paused for today (${today} already)`);
      return;
    }
    await runSellerKyc(sellerId, only);
    await refreshOverallKycStatus(sellerId);
  })().catch((err) => {
    if (err instanceof KycCheckRunningError) return; // another run has it
    console.error(`[clowe-api] KYC: automatic verification for seller ${sellerId} failed:`, err instanceof Error ? err.message : err);
  });
}

// ---------------------------------------------------------------------------
// What the admin sees
// ---------------------------------------------------------------------------

type ReviewRow = SellerKycReview & { reviewerName: string | null };

async function loadReviews(sellerId: string): Promise<ReviewRow[]> {
  const rows = await prisma.sellerKycReview.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' } });
  const ids = [...new Set(rows.map((r) => r.reviewerId))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true } }) : [];
  const names = new Map(users.map((u) => [u.id, u.name || u.phone]));
  return rows.map((r) => ({ ...r, reviewerName: names.get(r.reviewerId) ?? null }));
}

/** Every provider's answers: mock rows are read only to be set aside. */
async function loadAllChecks(sellerId: string): Promise<SellerKycCheck[]> {
  return prisma.sellerKycCheck.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' } });
}

export async function getSellerKycSummary(sellerId: string): Promise<SellerKycSummary> {
  const [seller, rows, reviews, settings] = await Promise.all([
    loadSeller(sellerId),
    loadAllChecks(sellerId),
    loadReviews(sellerId),
    getSettings(),
  ]);
  return summarize(seller, rows, settings.kycNameMatchMinScore, reviews, reviewMode());
}

/**
 * Where each check stands. Judged against the threshold at read time, so
 * moving it needs no re-verification.
 *
 * What decides, for the details on file now: the latest of an admin's review
 * and a real provider's answer. A mock provider's answer never decides — with
 * no real provider every check waits for an admin ("Pending review").
 */
export function summarize(
  seller: KycFields,
  rows: SellerKycCheck[],
  threshold: number,
  reviews: ReviewRow[] = [],
  mode: 'MANUAL' | 'PROVIDER' = reviewMode(),
): SellerKycSummary {
  // Real answers only. With a real provider live, only its own answers count
  // (answers from one provider never stand for another); with none, any real
  // answer given earlier still does.
  const real = rows.filter((r) => r.provider !== MOCK && (mode === 'MANUAL' || r.provider === kycProvider.name));
  const view = (kind: KycCheckType): KycCheckView => {
    const empty: KycCheckView = {
      check: kind,
      state: 'NOT_RUN',
      reason: null,
      nameScore: null,
      nameBand: null,
      nameMeetsThreshold: null,
      provider: null,
      checkedAt: null,
      method: null,
      decidedBy: null,
      rejectReason: null,
    };
    const target = checkableFor(kind, seller);
    const subject = reviewSubjectFor(kind, seller);
    if (!subject) {
      // Nothing valid on file: NOT_PROVIDED or INVALID_FORMAT.
      return isCheckable(target) ? empty : { ...empty, state: target.state, reason: target.reason };
    }

    const review = reviews.find((r) => r.kind === kind && r.subject === subject) ?? null;
    const history = isCheckable(target) ? historyFor(kind, target.subject, real) : { answer: null, lastError: null };
    const answer = history.answer;
    // The later of the admin's decision and the provider's answer stands.
    if (review && (!answer || review.createdAt >= answer.createdAt)) {
      return {
        ...empty,
        state: review.status === 'VERIFIED' ? 'VERIFIED' : 'REJECTED',
        provider: 'manual',
        checkedAt: review.createdAt.toISOString(),
        method: 'MANUAL',
        decidedBy: review.reviewerName,
        rejectReason: review.status === 'REJECTED' ? review.reason : null,
      };
    }
    if (answer) {
      return {
        ...empty,
        state: answer.outcome,
        reason: (answer.reason as KycReason | null) ?? null,
        nameScore: answer.nameScore,
        nameBand: answer.nameBand,
        nameMeetsThreshold: answer.nameScore === null ? null : answer.nameScore >= threshold,
        provider: answer.provider,
        checkedAt: answer.createdAt.toISOString(),
        method: 'PROVIDER',
      };
    }
    if (mode === 'MANUAL') return { ...empty, state: 'PENDING_REVIEW' };
    if (!isCheckable(target)) return { ...empty, state: target.state, reason: target.reason };
    if (history.lastError) {
      const e = history.lastError;
      return { ...empty, state: 'ERROR', reason: (e.reason as KycReason | null) ?? null, provider: e.provider, checkedAt: e.createdAt.toISOString() };
    }
    return empty;
  };

  const pan = seller.panNumber ? normalizeTaxId(seller.panNumber) : null;
  const mismatch = panGstinMismatch(seller.panNumber, seller.gstNumber);
  return {
    pan: view('PAN'),
    gstin: view('GSTIN'),
    bank: view('BANK'),
    panGstinMismatch: mismatch,
    panOnFile: mismatch ? pan : null,
    panInGstin: mismatch && seller.gstNumber ? panFromGstin(seller.gstNumber) : null,
    // Any account this seller submitted, not just the current one: switching
    // accounts after a fraud flag is itself worth knowing about.
    fraudAccount: real.some((r) => r.kind === 'BANK' && r.reason === 'FRAUD_ACCOUNT'),
    nameMatchThreshold: threshold,
    reviewMode: mode,
  };
}

/**
 * Which of these sellers have had a bank account flagged as fraudulent by
 * a real provider — for the list view, in one query. The PAN–GSTIN mismatch
 * needs no query; it is read straight off the profile.
 */
export async function sellersWithFraudFlag(sellerIds: string[]): Promise<Set<string>> {
  if (sellerIds.length === 0) return new Set();
  const flagged = await prisma.sellerKycCheck.findMany({
    where: {
      sellerId: { in: sellerIds },
      provider: { not: MOCK },
      kind: 'BANK',
      reason: 'FRAUD_ACCOUNT',
    },
    select: { sellerId: true },
    distinct: ['sellerId'],
  });
  return new Set(flagged.map((r) => r.sellerId));
}

// ---------------------------------------------------------------------------
// Manual review (an admin, against the documents)
// ---------------------------------------------------------------------------

/**
 * The shop's overall KYC status follows the three checks: VERIFIED once PAN,
 * GSTIN and bank account are all verified; REJECTED when any is rejected;
 * otherwise UNDER_REVIEW. A seller who has not finished the application keeps
 * PENDING_DOCS.
 */
export function overallKycStatus(summary: SellerKycSummary, current: SellerKycStatus): SellerKycStatus {
  const checks = [summary.pan, summary.gstin, summary.bank];
  if (checks.every((c) => c.state === 'VERIFIED')) return 'VERIFIED';
  if (checks.some((c) => c.state === 'REJECTED')) return 'REJECTED';
  return current === 'PENDING_DOCS' ? 'PENDING_DOCS' : 'UNDER_REVIEW';
}

/** Bring the stored overall status in line with the checks; returns it. */
export async function refreshOverallKycStatus(sellerId: string): Promise<SellerKycStatus> {
  const seller = await prisma.sellerProfile.findUniqueOrThrow({ where: { id: sellerId }, select: { kycStatus: true } });
  const next = overallKycStatus(await getSellerKycSummary(sellerId), seller.kycStatus);
  if (next !== seller.kycStatus) {
    await prisma.sellerProfile.update({ where: { id: sellerId }, data: { kycStatus: next, kycReviewedAt: new Date() } });
  }
  return next;
}

/**
 * An admin verifies or rejects one check against the documents. The decision
 * holds for the details on file; changing them needs a new one. A verified
 * bank account becomes the shop's verified payout account.
 */
export async function reviewSellerKyc(input: {
  sellerId: string;
  check: KycCheckType;
  decision: 'VERIFY' | 'REJECT';
  reason?: string;
  reviewerId: string;
}): Promise<SellerKycSummary> {
  const seller = await prisma.sellerProfile.findUniqueOrThrow({
    where: { id: input.sellerId },
    select: { ...KYC_FIELDS, bankName: true, bankAccountLast4: true },
  });
  const subject = reviewSubjectFor(input.check, seller);
  if (!subject) {
    throw ApiError.badRequest(`There is no valid ${input.check === 'BANK' ? 'bank account' : input.check} on file to review`, 'NOTHING_TO_REVIEW');
  }
  const verified = input.decision === 'VERIFY';
  await prisma.sellerKycReview.create({
    data: {
      sellerId: seller.id,
      kind: input.check,
      status: verified ? 'VERIFIED' : 'REJECTED',
      subject,
      reason: verified ? null : input.reason ?? null,
      reviewerId: input.reviewerId,
    },
  });
  if (input.check === 'BANK' && verified) await useAsPayoutAccount(seller);
  await refreshOverallKycStatus(seller.id);
  return getSellerKycSummary(seller.id);
}

/** The verified bank account as the shop's default payout method (verified). */
async function useAsPayoutAccount(seller: KycFields & { bankName: string | null; bankAccountLast4: string | null }): Promise<void> {
  const number = bankAccountNumberOf(seller);
  if (!number || !seller.bankIfsc) return;
  const last4 = number.slice(-4);
  const ifsc = normalizeTaxId(seller.bankIfsc);
  const existing = await prisma.sellerPayoutMethod.findFirst({ where: { sellerId: seller.id, type: 'BANK', accountLast4: last4, ifsc } });
  await prisma.$transaction(async (tx) => {
    await tx.sellerPayoutMethod.updateMany({ where: { sellerId: seller.id }, data: { isDefault: false } });
    if (existing) {
      await tx.sellerPayoutMethod.update({
        where: { id: existing.id },
        data: { verified: true, verifiedAt: new Date(), isDefault: true, accountName: seller.bankAccountName ?? existing.accountName },
      });
    } else {
      await tx.sellerPayoutMethod.create({
        data: {
          sellerId: seller.id,
          type: 'BANK',
          label: seller.bankName?.trim() || `Bank ${ifsc.slice(0, 4)}`,
          accountName: seller.bankAccountName ?? '',
          accountLast4: last4,
          ifsc,
          isDefault: true,
          verified: true,
          verifiedAt: new Date(),
        },
      });
    }
  });
}
