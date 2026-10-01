import type { PlatformSettings, SellerEconomicsRates } from '@clowe/shared';

/**
 * The rates the shared calculator needs, lifted from platform settings. One
 * mapping, used by the ledger, the payout views and the seller's pricing
 * endpoint, so a setting cannot reach one of them and not the others.
 *
 * gatewayPercent is payoutGatewayPercent: it already meant "payment gateway
 * charge withheld, percent of the line total", so the calculator reuses it
 * rather than growing a second copy. Commission is the platform rate alone;
 * categories carry GST rules but no commission rate of their own.
 */
export function economicsRates(settings: PlatformSettings): SellerEconomicsRates {
  return {
    commissionPercent: settings.payoutCommissionPercent,
    gatewayPercent: settings.payoutGatewayPercent,
    tdsPercent: settings.payoutTdsPercent,
    gstPercent: settings.gstRatePercent,
    platformFeePaise: settings.platformFeePaise,
    deliveryFeePaise: settings.deliveryFeePaise,
    closingFeePaise: settings.closingFeePaise,
  };
}
