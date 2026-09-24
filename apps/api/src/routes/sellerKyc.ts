import { Router } from 'express';
import { toSellerKycStatus } from '@clowe/shared';
import { requireAuth } from '../middleware/auth';
import { kycVerifyLimiter } from '../middleware/rateLimits';
import { KycCheckRunningError, getSellerKycSummary, runSellerKyc } from '../services/kyc/sellerKyc';
import { ApiError } from '../utils/ApiError';
import { requireSeller } from './seller';

/**
 * The seller's own KYC checks.
 *
 * Reading is free and makes no provider call. Verifying is rate-limited per
 * seller and only calls the provider for checks that have no answer yet —
 * pressing the button twice costs nothing the second time.
 *
 * The seller sees states and plain reasons, never name-match scores: a number
 * to tune against would only help someone fit a borrowed name to a PAN.
 */
export const sellerKycRouter = Router();
sellerKycRouter.use(requireAuth, requireSeller);

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
    const summary = await runSellerKyc(req.seller!.id);
    res.json({ success: true, data: toSellerKycStatus(summary) });
  } catch (err) {
    if (err instanceof KycCheckRunningError) {
      next(new ApiError(409, 'KYC_CHECK_RUNNING', 'Verification is already running — give it a moment.'));
      return;
    }
    next(err);
  }
});
