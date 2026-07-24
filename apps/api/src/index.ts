import { env } from './env';
import { createApp } from './app';

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`[clowe-api] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  console.log(`[clowe-api] health check: http://localhost:${env.PORT}/api/health`);
});
