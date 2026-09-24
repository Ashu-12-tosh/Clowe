# Clowe — Project Status

_Last updated: 2026-09-24 · commit `215a83d`_

Where the build stands, what is real and what is still a mock, and what has to
happen before and after the site goes live.

---

## Snapshot

| | |
|---|---|
| Feature phases (0–9) | **10 / 10 complete** |
| Database | 57 models, 45 migrations |
| API | 51 route modules |
| Web | 80 pages |
| Tests | **317 passing** — 179 unit, 138 integration |
| Full build | passing (`npm run build`) |
| Production stack | written and ready — Docker Compose + Nginx + SSL + backups |

The platform is **feature-complete and deployable**. What is left is not
features; it is swapping mock service providers for real ones, and the deploy
itself.

---

## What is built

**Storefront** — category tree, product listing with filters/facets/search
(Postgres full-text + parsed queries + suggestions), product detail with zoom
and variants, wishlist and shared wishlists, reviews, public order tracking.

**Buyer** — phone-OTP login with JWT + refresh rotation, cart, addresses,
checkout with atomic stock reservation, order lifecycle, cancellations,
returns and refunds, referral rewards, notification centre.

**Seller** — registration and approval flow, product CRUD with image upload and
variants, inventory, orders with ship/deliver, returns, promotions, store page,
support tickets, payouts view, settings, **automated KYC verification**.

**Admin** — seller moderation with KYC checks and fraud flags, product
moderation, category management, order and return oversight, platform
analytics, user block/unblock, platform settings, audit log, support desk.

**AI** — try-on ("Try On Me"), product description generation, review
summaries, voice search, support chat — all behind one service interface with
mock ↔ real switching by env key.

**Operations** — rate limiting across sensitive routes, upload hardening,
role-guard coverage, SEO (robots/sitemap/OG), error pages, nightly DB +
uploads backup script.

---

## Real vs mock — the actual remaining work

Every external service sits behind an interface, so switching one on is
configuration, not a rewrite — **except where the real implementation has not
been written yet**. That distinction is the whole table.

| Capability | Real implementation | To switch on | Blocks launch? |
|---|---|---|---|
| **Login OTP (SMS)** | ❌ **not written** — mock only | Implement MSG91/Twilio in `apps/api/src/services/otp/` | 🔴 **Yes** — nobody but you can log in |
| **Payments** | ✅ Razorpay written | Live keys + webhook URL in the Razorpay dashboard | 🔴 **Yes** — no money moves without it |
| **Seller KYC** | ✅ Cashfree written | Verification keys; flip `CASHFREE_VERIFICATION_ENV` to `production` | 🟠 Only if sellers onboard at launch |
| **AI try-on** | ✅ FASHN written | `FASHN_API_KEY` | 🟢 No — mock gives a watermarked preview |
| **AI features** | ✅ Claude written | `ANTHROPIC_API_KEY` | 🟢 No — mock text is usable |
| **WhatsApp / SMS / email** | ❌ **not written** — mock logs to console | Implement in `services/messaging/` (Gupshup/MSG91) | 🟠 Orders work; customers just hear nothing |
| **Shipping / delivery** | ❌ **not written** — mock fabricates AWB numbers | Implement in `services/shipping/` (Shiprocket/Delhivery) | 🟠 You can ship manually at first |
| **Seller payouts** | ❌ **not written** — mock only | Implement in `services/payouts/` (Razorpay Payouts / Cashfree Payouts) | 🟠 Not needed until sellers are owed money |
| **Image / file storage** | ⚠️ local disk in a Docker volume | Move `uploads/` to S3-compatible storage (`routes/uploads.ts`) | 🟢 No — works, but does not survive losing the VPS |

**Short version:** three real providers are written and waiting for keys
(Razorpay, Cashfree, FASHN/Claude). Four are still mocks that need real code —
OTP SMS, messaging, shipping, payouts. Of those four, **only OTP SMS blocks a
public launch**; the rest can be done by hand at low volume.

---

## Going live — the deploy itself

Fully documented in [DEPLOYMENT.md](DEPLOYMENT.md). Roughly 1–1.5 hours, most
of it spent waiting on the Docker build and DNS.

1. Hostinger VPS, **KVM 2 or better** (2+ vCPU, 4+ GB RAM — the Next.js build
   OOMs on smaller).
2. Install Docker, open ports 80/443 with ufw.
3. Point the domain's `A` records at the VPS IP.
4. Clone the repo, fill `.env.production`, replace `yourdomain.com` in
   [nginx/nginx.conf](nginx/nginx.conf).
5. `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`
6. Seed the admin account and catalog.
7. Issue the Let's Encrypt certificate, enable the HTTPS block, add the renewal
   cron.
8. Enable the nightly backup cron.

### Known deploy-time gotchas

- **Seeding** — the production image prunes dev dependencies, so `tsx` may be
  missing inside the container. DEPLOYMENT.md §5 has the workaround.
- **`SITE_URL` is baked into the web build.** Image URLs and CORS come from it,
  so changing it later means rebuilding the web container.
- **Login OTPs print to the API logs** until a real SMS provider exists:
  `docker compose -f docker-compose.prod.yml logs -f api | grep OTP`.
- **KYC on the mock marks everything verified.** That is not a real check — do
  not approve sellers against it in production.
- **`KYC_FINGERPRINT_SECRET` is set once and never rotated.** A new key makes
  every verified PAN, GSTIN and bank account look changed, and every one gets
  re-verified and re-billed.

---

## After going live — priority order

**1. Unblock real users (do first)**
- Real OTP SMS provider — nothing else matters until people can log in.
- Razorpay live keys + webhook registered and tested against a real payment.

**2. Make the business work**
- Cashfree Verification in production mode before approving real sellers.
- Order notifications (WhatsApp/SMS/email) so buyers hear about their orders.
- Seller payouts — needed before the first payout cycle is due.

**3. Harden**
- Move uploads to S3-compatible storage; today they live only on the VPS disk.
- Verify the nightly backup actually runs and copy backups off the VPS.
- Shipping partner integration to replace manual AWB entry.

**4. Polish**
- FASHN and Claude keys to turn the AI features real.
- Set the KYC name-match threshold from real seller data rather than the
  default of 85.
