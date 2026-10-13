## Working style

- Do not use sub-agents unless I explicitly ask. Work in a single
  session, in order.
- Before running any script that can call a paid provider (try-on, AI,
  KYC verification, SMS/OTP, payments, payouts — e.g. `npm run tryon:e2e`,
  `npm run tryon:check -- --live`), check which provider is active: the
  `*_PROVIDER` setting and whether its key is set in `.env` / `.env.local`,
  or the API's boot log. If it is a real (paid) provider, stop and ask
  before running it.
- Shipping (Delhivery): `SHIPPING_PROVIDER=mock` stays the default and
  `DELHIVERY_ENV=staging` is the default whenever Delhivery is configured.
  Nothing may book a real (production) shipment, request a real pickup,
  cancel a real shipment, or spend Delhivery wallet money — from code,
  scripts, tests or by hand — without my explicit yes for that specific
  action. Staging calls are fine; anything against `track.delhivery.com`
  (production) is not, until I say so.
