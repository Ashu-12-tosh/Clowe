import { env } from './env';
import { createApp } from './app';
import { startPackingVideoCleanup } from './services/packingVideos';
import { startLateDispatchJob } from './services/lateDispatch';
import { startTryOnPhotoRetention } from './services/tryonPhotoRetention';
import { logStorageStatus } from './services/storage';
import { logTryOnProviderStatus } from './services/tryon';
import { logKycProviderStatus } from './services/kyc';
import { logShippingProviderStatus } from './services/shipping';
import { startTrackingPoll } from './services/shipping/tracking';
import { startLostParcelSweep } from './services/shipping/lostParcels';
import { startComplaintBreachSweep } from './services/complaintService';
import { startSellerInvoiceJob } from './services/sellerInvoice';
import { startPlanJobs } from './services/planService';
import { startAdJobs } from './services/advertising';
import { startTryOnCreditJobs } from './services/tryonCredits';
import { startFeeChangeJob } from './services/feeChanges';
import { logOtpProviderStatus } from './services/otp';
import { startSearchLogCleanup } from './services/searchAnalytics';
import { startQuerySuggestionRefresh } from './services/querySuggestions';
import { logEmailProviderStatus, startEmailJobs } from './services/email';
import { logPaymentProviderStatus } from './services/payments';
import { startPaymentSweeper } from './services/payments/gatewaySync';
import { startRefundPoller } from './services/refundService';
import { logPayoutProviderStatus } from './services/payouts';
import { startPayoutPoller } from './services/payoutService';
import { startEasySplitJobs } from './services/easySplit';

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`[clowe-api] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  console.log(`[clowe-api] health check: http://localhost:${env.PORT}/api/health`);
  // Reports the live try-on provider, and warns at boot if the key is bad.
  void logTryOnProviderStatus();
  logOtpProviderStatus();
  logPaymentProviderStatus();
  logPayoutProviderStatus();
  logKycProviderStatus();
  logShippingProviderStatus();
  logEmailProviderStatus();
  void logStorageStatus();
});

// Packing videos expire 45 days after delivery (never while a return is open) - swept at boot and hourly.
startPackingVideoCleanup();

// Late-dispatch penalties are charged when the deadline passes, shipped or not - at boot and every 5 minutes.
startLateDispatchJob();
// Courier scans for every parcel still moving, every 30 minutes.
startTrackingPoll();
// Parcels 15 days past their estimate and untraceable are flagged lost - at boot and every 6 hours.
startLostParcelSweep();
// Support tickets past their acknowledge, resolve or seller deadline - every 30 minutes.
startComplaintBreachSweep();
// Clowe's monthly tax invoices to sellers, issued once a month ends - checked every 6 hours.
startSellerInvoiceJob();
// Plan renewals, grace and the product-limit notices - hourly.
startPlanJobs();
startAdJobs();
startTryOnCreditJobs();
startFeeChangeJob();

// Shoppers' try-on photos are deleted 24 hours after upload - every 10 minutes.
startTryOnPhotoRetention();

// Logged searches expire too - swept at boot and daily after that.
startSearchLogCleanup();

// Query suggestions are built from the catalog and the search log in the
// background - at boot, then every 15 minutes - and never per keystroke.
startQuerySuggestionRefresh();

// Email: notifications into the queue, and the queue out within the daily cap - every 30 seconds.
startEmailJobs();

// Unpaid gateway orders whose time is up: asked about (they may have been paid
// after all), else cancelled and their stock returned - every 5 minutes.
startPaymentSweeper();
// Gateway refunds and payout transfers still on their way: asked about every
// 15 minutes, beside the webhooks that normally bring the answer first.
startRefundPoller();
startPayoutPoller();
// Easy Split (SETTLEMENT_MODE=easy_split only): vendors for verified sellers,
// and shares released after the hold - hourly.
startEasySplitJobs();
