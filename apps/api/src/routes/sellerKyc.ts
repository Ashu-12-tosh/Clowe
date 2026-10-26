import { Router } from 'express';
import { toSellerKycStatus } from '@clowe/shared';
import { requireAuth } from '../middleware/auth';
import { kycVerifyLimiter } from '../middleware/rateLimits';
import { getSellerKycSummary } from '../services/kyc/sellerKyc';
import { blockSuspendedWrites, requireSeller } from './seller';

/**
 * The seller's own KYC checks.
 *
 * Read-only. Every verification call is billed, so none is ever started by a
 * seller: an admin runs each check from the KYC review. /verify is kept for
 * older clients and only returns the current status.
 *
 * The seller sees states and plain reasons, never name-match scores: a number
 * to tune against would only help someone fit a borrowed name to a PAN.
 */
export const sellerKycRouter = Router();
sellerKycRouter.use(requireAuth, requireSeller, blockSuspendedWrites);

sellerKycRouter.get('/', async (req, res, next) => {
  try {
    const summary = await getSellerKycSummary(req.seller!.id);
    res.json({ success: true, data: toSellerKycStatus(summary) });
  } catch (err) {
    next(err);
  }
});

sellerKycRouter.post('/verify', kycVerifyLimiter, async (req, res, next) => {
  try {
    const summary = await getSellerKycSummary(req.seller!.id);
    res.json({ success: true, data: toSellerKycStatus(summary) });
  } catch (err) {
    next(err);
  }
});
