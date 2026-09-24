import { env } from './env';
import { createApp } from './app';
import { startPackingVideoCleanup } from './services/packingVideoCleanup';
import { logTryOnProviderStatus } from './services/tryon';
import { logKycProviderStatus } from './services/kyc';
import { startSearchLogCleanup } from './services/searchAnalytics';
import { startQuerySuggestionRefresh } from './services/querySuggestions';

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`[clowe-api] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  console.log(`[clowe-api] health check: http://localhost:${env.PORT}/api/health`);
  // Reports the live try-on provider, and warns at boot if the key is bad.
  void logTryOnProviderStatus();
  logKycProviderStatus();
});

// Packing videos expire after 10 days - swept at boot and hourly after that.
startPackingVideoCleanup();

// Logged searches expire too - swept at boot and daily after that.
startSearchLogCleanup();

// Query suggestions are built from the catalog and the search log in the
// background - at boot, then every 15 minutes - and never per keystroke.
startQuerySuggestionRefresh();
