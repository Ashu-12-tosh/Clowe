import { createHmac } from 'node:crypto';
import type { SellerKycCheck, SellerProfile } from '@prisma/client';
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
  'id' | 'panNumber' | 'panName' | 'gstNumber' | 'bankAccountNo' | 'bankIfsc' | 'bankAccountName'
>;

const KYC_FIELDS = {
  id: true,
  panNumber: true,
  panName: true,
  gstNumber: true,
  bankAccountNo: true,
  bankIfsc: true,
  bankAccountName: true,
} as const;

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
      if (!seller.bankAccountNo?.trim() || !seller.bankIfsc?.trim()) {
        return { state: 'NOT_PROVIDED', reason: null };
      }
      const account = normalizeTaxId(seller.bankAccountNo);
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

// ---------------------------------------------------------------------------
// What the admin sees
// ---------------------------------------------------------------------------

export async function getSellerKycSummary(sellerId: string): Promise<SellerKycSummary> {
  const [seller, rows, settings] = await Promise.all([
    loadSeller(sellerId),
    loadChecks(sellerId),
    getSettings(),
  ]);
  return summarize(seller, rows, settings.kycNameMatchMinScore);
}

/** Judged against the threshold at read time, so moving it needs no re-verification. */
export function summarize(seller: KycFields, rows: SellerKycCheck[], threshold: number): SellerKycSummary {
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
    };
    const target = checkableFor(kind, seller);
    if (!isCheckable(target)) return { ...empty, state: target.state, reason: target.reason };

    const { answer, lastError } = historyFor(kind, target.subject, rows);
    const row = answer ?? lastError;
    if (!row) return empty;
    return {
      check: kind,
      state: row.outcome,
      reason: (row.reason as KycReason | null) ?? null,
      nameScore: row.nameScore,
      nameBand: row.nameBand,
      nameMeetsThreshold: row.nameScore === null ? null : row.nameScore >= threshold,
      provider: row.provider,
      checkedAt: row.createdAt.toISOString(),
    };
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
    fraudAccount: rows.some((r) => r.kind === 'BANK' && r.reason === 'FRAUD_ACCOUNT'),
    nameMatchThreshold: threshold,
  };
}

/**
 * Which of these sellers have had a bank account flagged as fraudulent by
 * the provider — for the list view, in one query. The PAN–GSTIN mismatch
 * needs no query; it is read straight off the profile.
 */
export async function sellersWithFraudFlag(sellerIds: string[]): Promise<Set<string>> {
  if (sellerIds.length === 0) return new Set();
  const flagged = await prisma.sellerKycCheck.findMany({
    where: {
      sellerId: { in: sellerIds },
      provider: kycProvider.name,
      kind: 'BANK',
      reason: 'FRAUD_ACCOUNT',
    },
    select: { sellerId: true },
    distinct: ['sellerId'],
  });
  return new Set(flagged.map((r) => r.sellerId));
}
