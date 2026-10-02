## Working style

- Do not use sub-agents unless I explicitly ask. Work in a single
  session, in order.
- Before running any script that can call a paid provider (try-on, AI,
  KYC verification, SMS/OTP, payments, payouts — e.g. `npm run tryon:e2e`,
  `npm run tryon:check -- --live`), check which provider is active: the
  `*_PROVIDER` setting and whether its key is set in `.env` / `.env.local`,
  or the API's boot log. If it is a real (paid) provider, stop and ask
  before running it.
