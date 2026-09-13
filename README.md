# Clowe

Multi-vendor e-commerce marketplace (electronics, mobiles, fashion, home & kitchen, beauty, books, grocery and more) with AI virtual try-on ("Try On Me") on fashion.

**Architecture:** API-first monorepo. The backend is a standalone REST API; the web frontend (and a future mobile app) consume the same APIs.

```
/apps
  /api        → Express + TypeScript + Prisma + PostgreSQL (REST API)
  /web        → Next.js (App Router) + Tailwind CSS (storefront)
/packages
  /shared     → shared types + zod validation schemas
```

## Prerequisites

- Node.js ≥ 20
- Docker (for PostgreSQL)

## Setup (first time)

```bash
# 1. Install all workspace dependencies
npm install

# 2. Start PostgreSQL
npm run db:up

# 3. Create env files from the examples
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

# 4. Generate the Prisma client and apply migrations
npm run db:generate
npm run db:migrate          # answer with a migration name like "init"

# 5. Build the shared package once
npm run build --workspace=@clowe/shared

# 6. Seed the admin account (uses ADMIN_PHONE from apps/api/.env)
npm run db:seed --workspace=@clowe/api

# 7. Fetch the demo catalog's placeholder images once (~75 MB into apps/api/uploads/demo,
#    gitignored) so pages never wait on picsum/loremflickr. Safe to re-run after a re-seed.
npm run db:localize-images --workspace=@clowe/api
```

## Marketplace categories, variants & rules

Clowe is category-agnostic. The behaviour that used to be hard-coded for clothing now lives on the category tree (`Category` model, editable in **Admin → Categories → Rules**, inherited by children):

| Rule | What it drives |
|---|---|
| `variantAxes` | Option columns sellers get by default (Colour × Size for Fashion, Colour × Storage × RAM for Mobiles…). Sellers can add their own axes (max 3). |
| `attributeSchema` | The spec sheet on the listing form and product page; `required` fields block submission for review. |
| `tryOnEligible` / `sizeGuide` | AI Try-On and the size guide only appear in wearable categories. |
| `taxRule` / `defaultTaxRatePercent` / `hsnCode` | GST default for listings without their own slab (`APPAREL_SLAB` = 5%/12% by price; electronics 18%; books 0%). |
| `returnWindowDays` | Return window per department (a seller policy overrides it; the platform setting is the last fallback). |

Variants are keyed on `ProductVariant.optionValues` (e.g. `{"ram":"16GB","storage":"512GB"}`) with a unique `(productId, optionsKey)`; `size`/`color` are display caches and `label` is the human string ("Black · L"). Order items snapshot `variantLabel` + `optionValues`. Storefront filters accept `opt[<axis>]=a,b` for any axis and facets come back as `facets.options`.

## Run (development)

```bash
npm run dev        # runs API + web together
# or separately:
npm run dev:api    # API  → http://localhost:4400
npm run dev:web    # Web  → http://localhost:4300
```

## Verify Phase 0

| Check | How |
|---|---|
| API health | `curl http://localhost:4400/api/health` → `{"success":true,"data":{"status":"ok",...,"database":"up"}}` |
| Web hello page | Open http://localhost:4300 — Clowe page shows **API connected** and **Database: connected** |
| DB running | `docker ps` shows `clowe-db` |

## Verify Phase 1 — Database & Auth

**Login in the browser (easiest):**

1. Run `npm run dev`, open http://localhost:4300/login
2. Enter any valid Indian mobile number (e.g. `9876543210`) → **Send OTP**
3. Look at the **API terminal** — the mock provider prints the OTP there:
   ```
   [clowe-api] ===== MOCK OTP =====
   [clowe-api] Phone: +91 9876543210
   [clowe-api] OTP:   483920
   ```
4. Enter the OTP → you're logged in (account auto-created on first login)
5. Login with the `ADMIN_PHONE` from `apps/api/.env` (default `9999999999`) → role badge shows **ADMIN** (run the seed first)

**Auth API endpoints:**

| Endpoint | What it does |
|---|---|
| `POST /api/auth/request-otp` | `{ "phone": "9876543210" }` → sends OTP (45s resend cooldown) |
| `POST /api/auth/verify-otp` | `{ "phone", "code", "name?", "referralCode?" }` → creates account if new, returns `user + accessToken + refreshToken` |
| `POST /api/auth/refresh` | `{ "refreshToken" }` → new token pair (old refresh token is revoked — rotation) |
| `POST /api/auth/logout` | `{ "refreshToken" }` → revokes that token |
| `GET /api/auth/me` | Requires `Authorization: Bearer <accessToken>` → current user |

**Auth design:** OTPs are stored hashed with 5-min expiry and max 5 wrong attempts; JWT access tokens last 15 min; refresh tokens are opaque, stored hashed, rotate on every refresh, and last 30 days. Role guards (`requireAuth`, `requireRole`) protect routes — used by the seller/admin dashboards in later phases.

**Database:** the full e-commerce schema is in [apps/api/prisma/schema.prisma](apps/api/prisma/schema.prisma) — users, sellers, categories, products + variants + images, carts, orders + items, payments, addresses, wishlists, reviews, returns, referrals, try-on history, notifications. Prices are stored in **paise** (integers). Browse it with `npm run db:studio -w @clowe/api`.

**Test accounts:**

| Account | Phone | How |
|---|---|---|
| Admin | `9999999999` (from `ADMIN_PHONE`) | Seeded via `npm run db:seed -w @clowe/api` |
| Customer | any other valid number | Auto-created on first OTP login |

## Verify Phase 2 — Product Catalog

1. Re-run the seed to load the demo catalog: `npm run db:seed -w @clowe/api` (creates a demo seller, 13 categories, 24 products with size/colour variants — skipped if products already exist)
2. Open http://localhost:4300 — home page shows category tiles → **Shop now**
3. http://localhost:4300/products — filter by category / size / colour / price, search from the header, sort, paginate
4. Click any product — detail page with **hover-to-zoom** images, colour & size selection, stock hints
5. Click the ♡ on any card (login required) — then check http://localhost:4300/wishlist

**Catalog API endpoints:**

| Endpoint | What it does |
|---|---|
| `GET /api/categories` | Active category tree (Men/Women/Kids → subcategories) |
| `GET /api/products` | Listing with `q`, `category`, `sizes`, `colors`, `minPrice`/`maxPrice` (₹), `sort` (`newest`/`price_asc`/`price_desc`), `page`, `limit`. Returns items + total + size/colour facets. Only APPROVED products. |
| `GET /api/products/:slug` | Full detail: variants, images, seller shop name, rating summary |
| `GET /api/wishlist` · `POST /api/wishlist/:productId` · `DELETE /api/wishlist/:productId` | Wishlist (requires auth) |

## Verify Phase 3 — Seller Dashboard

**As the approved demo seller (fastest):**

1. Login at http://localhost:4300/login with phone `9000000001` (pre-approved seller)
2. Click **Sell** in the header → seller dashboard with stats (24 live products)
3. **My Products** — the seeded catalog with status chips; try **Edit** (edits reset the product to PENDING for re-approval — it disappears from the public shop until re-approved)
4. **Add Product** — upload real images (JPG/PNG/WebP, max 5 MB), add size/colour variant rows, submit → status **PENDING**, not visible in the shop until admin approval (Phase 4)

**As a new seller:**

1. Login with any fresh number → **Sell** → registration form (shop name + optional KYC)
2. After submitting: dashboard shows a **PENDING — under review** banner, and adding products is blocked until the admin approves you (Phase 4)

**Seller API endpoints** (all require auth):

| Endpoint | What it does |
|---|---|
| `POST /api/seller/register` | Apply as seller → profile status PENDING, role becomes SELLER |
| `GET /api/seller/profile` | Own profile + approval status |
| `GET/POST /api/seller/products` · `GET/PUT/DELETE /api/seller/products/:id` | Own products only. Create/edit → status PENDING (admin re-approval). Delete = archive. |
| `POST /api/uploads` | Multipart image upload (field `images`, up to 6) → public URLs. Local disk in dev, S3-compatible later. |
| `GET /api/seller/orders` · `PATCH /api/seller/orders/:itemId/status` | Own order items; mark `ship`/`deliver` (populates after Phase 5) |
| `GET /api/seller/stats` | Live/pending products, units sold, revenue, low-stock count |

## Verify Phase 4 — Admin Dashboard

1. Login at http://localhost:4300/login with the admin phone (`9999999999`) → open http://localhost:4300/admin
2. **Dashboard** — platform totals (revenue, orders, users, sellers, live products), pending-approval shortcuts, top products, per-seller breakdown
3. **Sellers** — the "Ashu Test Shop" application is waiting: approve or reject it (seller gets a notification either way)
4. **Products** — your pending product is waiting: approve it → it appears in the public shop; reject it (with reason) → the seller sees the reason on their product list
5. **Categories** — add a category (top-level or under Men/Women/Kids), deactivate/activate (deactivated ones vanish from the storefront)
6. **Users** — search by name/phone, filter by role, block/unblock (blocking revokes all the user's sessions; admins can't be blocked)
7. **Orders** — platform-wide order table (fills up after Phase 5)

**Admin API endpoints** (all require the ADMIN role):

| Endpoint | What it does |
|---|---|
| `GET /api/admin/stats` | Platform analytics: totals, pending counts, top products, per-seller breakdown |
| `GET /api/admin/sellers?status=` · `PATCH /api/admin/sellers/:id` | List + `approve`/`reject`/`suspend` (with reason → notification) |
| `GET /api/admin/products?status=` · `PATCH /api/admin/products/:id` | List + `approve`/`reject` listings |
| `GET/POST /api/admin/categories` · `PATCH /api/admin/categories/:id` | Category tree management (2 levels max) |
| `GET /api/admin/users?q=&role=` · `PATCH /api/admin/users/:id` | Search users, block/unblock (`isActive`) |
| `GET /api/admin/orders` | Recent orders across the platform |

## Verify Phase 5 — Cart, Checkout & Payments

1. Login as a customer → open any product → pick a size → **Add to Cart** → 🛒 **Cart** in the header
2. Cart: quantity steppers, remove, price summary (shipping **free at/above ₹999**, else ₹49)
3. **Proceed to Checkout** → add/select a delivery address → **Place order & pay**
4. Dev mode shows a **Mock Payment Gateway** screen — simulate success or failure:
   - Success → order **CONFIRMED**, cart cleared, sellers notified, revenue appears in seller + admin dashboards
   - Failure → order **CANCELLED**, reserved stock restored
5. **Orders** (header) → order detail with per-item status, delivery address, payment info; **Cancel order** (until shipped, restores stock); **Request return** on delivered items
6. Seller side: login `9000000001` → Sell → Orders → **Mark shipped** → **Mark delivered** (only paid orders are visible/shippable)

**Real Razorpay (test mode):** in `apps/api/.env` set `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID=rzp_test_…`, `RAZORPAY_KEY_SECRET=…` (and `RAZORPAY_WEBHOOK_SECRET` for webhooks at `POST /api/payments/webhook`). The checkout page then opens the real Razorpay window; signatures are verified server-side.

**Order/payment API:**

| Endpoint | What it does |
|---|---|
| `GET/POST/PATCH/DELETE /api/cart…` | Cart with stock checks and totals |
| `GET/POST/PUT/DELETE /api/addresses…` | Address book (first address becomes default) |
| `POST /api/orders/checkout` | Cart → order: stock reserved atomically, `CLW-YYYY-XXXXXX` number, gateway order created |
| `POST /api/payments/mock-pay` | Dev-only settle (success/failure) |
| `POST /api/payments/verify` · `POST /api/payments/webhook` | Razorpay signature verification (client callback + server webhook, idempotent) |
| `GET /api/orders` · `GET /api/orders/:id` | My orders + detail |
| `POST /api/orders/:id/cancel` | Cancel before shipping (restores stock, marks refund) |
| `POST /api/orders/items/:itemId/return` | Return request on delivered items |

**Status lifecycle:** `PLACED` (unpaid) → `CONFIRMED` (paid) → `SHIPPED` → `DELIVERED` → `RETURN_REQUESTED` → `RETURNED`; `CANCELLED` on failure/cancel. Sellers never see unpaid orders.

## Verify Phase 6 — AI Try-On ("Try On Me") ⭐

1. Login as a customer → open any fashion product → hit **Try On Now**
2. A panel slides in over the right of the product page — the listing, price and Add to Cart stay behind it. No navigation, no second tab.
3. The photo comes from the account (asked for once at sign-up), so the normal path is one press of **Generate my try-on**. **Use a different photo** swaps it, and the new one becomes the saved one.
4. Dev/mock mode returns a watermarked composite preview ("CLOWE AI TRY-ON — MOCK PREVIEW") — free, no API key needed
5. Every run is kept: flip between results for this product in the panel, rate the fit, or see them all at http://localhost:4300/tryon
6. Limits: 10 try-ons/user/day (failed runs don't count), one at a time per user

`/products/<slug>?tryon=1` opens a product with the panel already open — that is what "Try On" links from elsewhere (e.g. the wishlist) point at.

### Going live with real AI try-on (FASHN)

1. Get a key at https://fashn.ai → Settings → API, and put it in `apps/api/.env`:
   ```
   FASHN_API_KEY=fa-your-key-here
   ```
2. Restart the API. The boot log says which provider is live and warns immediately if the key is rejected:
   ```
   [clowe-api] AI Try-On: FASHN (tryon-v1.6, mode=balanced)
   ```
3. Verify before letting shoppers near it:
   ```bash
   npm run tryon:check --workspace=@clowe/api            # config + key, nothing billed
   npm run tryon:check --workspace=@clowe/api -- --live  # one real run, 1 credit
   npm run tryon:e2e   --workspace=@clowe/api            # whole pipeline over HTTP
   ```
4. Try it as a shopper. The seeded catalog uses random stock photos, so its "garments" are often landscapes or animals and the results tell you nothing. This lists one real, properly photographed garment to try it on:
   ```bash
   npm run seed:tryon-demo --workspace=@clowe/api
   ```
   Then open `/products/truethread-essential-v-neck-tee?tryon=1`, press **Use a different photo**, pick a clear front-facing photo of yourself, and **Generate**. One run costs 1 FASHN credit.

`TRYON_PROVIDER=auto` switches to FASHN the moment a key is present — no code change. Tunables in `.env`: `FASHN_MODEL` (`tryon-v1.6` at 1 credit/image, or `tryon-max` for higher quality at more credits), `FASHN_MODE` (`performance` ~5s / `balanced` ~8s / `quality` ~12-17s) and `TRYON_TIMEOUT_MS`.

**How the pipeline behaves**

| Concern | What happens |
|---|---|
| Image prep | Both images are EXIF-rotated, resized into FASHN's 864×1296 processing box and re-encoded as JPEG. Re-encoding also strips EXIF, so a shopper's GPS coordinates never leave the server. |
| Transport | Images go as base64 data URIs, so try-on works from localhost and from a private staging host. Typical payload is ~100 KB per image. |
| Category | The product's category picks `tops` / `bottoms` / `one-pieces`; anything ambiguous falls back to FASHN's own classifier. |
| Failures | Every call has a timeout and retries 5xx/429 up to 3 times. Shoppers see a plain message ("out of credits", "try a clearer photo"); the raw upstream text goes to `tryon_history.errorMessage` for the admin monitor. |
| Results | Downloaded and re-hosted under `/uploads`, so they outlive FASHN's expiring CDN links. |
| Cost | A successful run logs `TRYON_COST_PAISE` (default ₹6.50), decrements the seller's try-on credits and writes a `tryOnCreditLedger` row. Failures cost nothing and don't count against the shopper's daily quota. |
| Eligibility | Only wearable garments run. Footwear, bags, watches, sunglasses, jewellery, caps and accessories are excluded in the category rules — the model cannot place those on a person, so every attempt would waste a credit. |
| Only the garment changes | `segmentation_free` fits the garment directly instead of masking the photo first, so the shopper's pose, face, body and background come through untouched — the result is their own photo with the clothing swapped. |
| Children's clothing | Kids sizing is by age ("4-5Y"), and try-on is refused below **5 years**. The gate is on the size being tried on, not the listing: a t-shirt sold in 4-5Y / 6-7Y / 8-9Y keeps the feature and refuses only the 4-5Y run. A request with no size falls back to the listing's smallest, so omitting it cannot open the gate. Change the cut-off in `TRYON_MIN_AGE_YEARS` ([ageGate.ts](apps/api/src/services/tryon/ageGate.ts)). |
| Sensitive garments | Innerwear, lingerie, swimwear, sleepwear and shapewear never run, whatever category they are filed under. Try-on paints a garment onto a photo of a real customer, and for these that means generating a near-undressed image of them. Enforced in three places: the Innerwear department's category rule, `isSensitiveForTryOn()` on the product title and category (so a bikini listed under "Women" is still refused), and the seller form, which will not set `tryOnEnabled` on such a listing. FASHN's own `moderation_level` is set to `conservative` as a provider-side backstop on the uploaded photo. |

Kill switches live in **Admin → Try-On**: an on/off toggle, the daily limit per shopper, a minimum product price and a monthly spend cap.

**Try-on API:**

| Endpoint | What it does |
|---|---|
| `GET /api/tryon/quota` | Daily limit, used count, active provider |
| `POST /api/tryon` | `{ productId, photoUrl }` → generates, saves to `tryon_history` with cost |
| `GET /api/tryon/history` | My past try-ons |

## Verify Phase 7 — Other AI Features

All four features run behind one `AIService` abstraction. Out of the box they use a **free mock provider**; add `ANTHROPIC_API_KEY=sk-ant-...` to `apps/api/.env` (key from https://platform.claude.com) and every feature switches to **real Claude AI** (`claude-opus-4-8`) — no code changes.

1. **AI product descriptions (sellers):** Sell → Add Product → enter a title → **✨ Generate with AI** next to the description field. Anything already typed in the description is used as hints (fabric, fit…).
2. **AI review summaries:** re-run the seed (`npm run db:seed -w @clowe/api`) to load demo reviews, then open a product page → purple **✨ AI summary of reviews** box (appears at 3+ reviews, cached 1h). Customers can write/edit their own review below it.
3. **AI voice search:** click the 🎙 in the header search bar (Chrome/Safari) and say e.g. *"show me women dresses under 1500 in red"* → the shop opens with search + category + price + colour filters applied.
4. **AI support chat:** floating 💬 button (bottom-right, every page) — ask about orders, returns, shipping, try-on, or selling. Works for guests, 50 messages/day per IP.

**AI API endpoints:**

| Endpoint | What it does |
|---|---|
| `POST /api/ai/product-description` | `{ title, brand?, categoryName?, keywords? }` → marketing description (auth) |
| `GET /api/ai/review-summary/:productId` | 2-3 sentence summary of reviews (public, ≥3 reviews, 1h cache) |
| `POST /api/ai/search-intent` | `{ transcript }` → `{ q, category, maxPrice, colors }` (public) |
| `POST /api/ai/support-chat` | `{ messages: [{role, content}] }` → assistant reply (public, rate-limited) |
| `GET/POST /api/products/:productId/reviews` | List reviews / write-update my review (one per user per product) |

## Verify Phase 8 — Growth & Notifications

1. **Refer & Earn:** login → account page (top-right name) → **🎁 Refer & Earn** — your code, share message, and earnings. Signup with the code on a second account, place & pay a first order → referrer instantly gets **₹100 credited** (`REFERRAL_REWARD_PAISE`), a 🔔 notification, and a (mock) WhatsApp message.
2. **Notifications:** 🔔 bell in the header shows the unread count → `/notifications` lists everything (order confirmed/shipped/delivered, seller approvals, referral rewards). Opening the page marks all read.
3. **WhatsApp/email/SMS hooks:** provider-agnostic `MessagingService` — in dev every send is printed in the API console (`MOCK 🟢 WhatsApp`). Order confirmation, shipping, and referral messages already wired.
4. **Order tracking:** public page http://localhost:4300/track — order number + phone (no login), per-item timeline Confirmed → Shipped → Delivered with courier + AWB.
5. **Delivery partner stub:** when a seller hits **Mark shipped**, the Shiprocket-style `ShippingProvider` books a (mock) shipment — AWB number + courier saved on the item, shown on the order page, tracking page, and in the customer's notification.

**Growth API endpoints:**

| Endpoint | What it does |
|---|---|
| `GET /api/referrals/me` | My code, share text, per-referral status, total earned (auth) |
| `GET /api/notifications` · `POST /api/notifications/read-all` | In-app notification center (auth) |
| `GET /api/track?orderNumber=&phone=` | Public order tracking (phone must match the order) |

## Verify Phase 9 — Security, Polish & Deployment

**Security hardening:**

- Rate limiting on every API route (300/min global) with strict limits on OTP endpoints (10 requests / 15 min — brute-force protection), uploads, and AI endpoints. Standard `RateLimit-*` headers.
- Upload magic-byte verification — files must *actually be* JPEG/PNG/WebP, not just claim to be.
- All inputs zod-validated; role guards audited across every router (auth + ownership + role).
- Helmet security headers, CORS locked to configured origins, `trust proxy` for correct IPs behind Nginx.

**Polish & SEO:** site-wide metadata + OpenGraph, `robots.txt` (private areas disallowed), dynamic `sitemap.xml` with live product pages, custom 404 / error / loading pages.

**Deployment (see [DEPLOYMENT.md](DEPLOYMENT.md) for the full Hostinger VPS guide):**

```bash
cp .env.production.example .env.production   # fill in SITE_URL, secrets, ADMIN_PHONE
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Ships 4 containers: Postgres (persistent volume) + API (auto-migrates on boot) + Next.js (standalone build) + Nginx (reverse proxy, SSL-ready with Let's Encrypt instructions). Nightly backup script for DB + uploads in [scripts/backup-db.sh](scripts/backup-db.sh).

## Useful commands

| Command | What it does |
|---|---|
| `npm run db:up` / `npm run db:down` | Start / stop PostgreSQL container |
| `npm run db:migrate` | Create & apply a Prisma migration |
| `npm run db:studio -w @clowe/api` | Browse the DB in Prisma Studio |
| `npm run lint` | Lint all workspaces |
| `npm run format` | Prettier-format the repo |

## Phase status

- [x] **Phase 0** — Monorepo scaffold, Postgres via Docker, Prisma init, health check, hello page
- [x] **Phase 1** — Full DB schema (18 models), phone-OTP auth (mock provider), JWT + refresh rotation, role middleware, login page
- [x] **Phase 2** — Category tree, product listing (filters/search/facets/pagination), detail page with zoom + variants, wishlist, seeded catalog
- [x] **Phase 3** — Seller registration (KYC-lite, PENDING until approved), seller dashboard, product CRUD with image upload + variants, orders view with ship/deliver, stats
- [x] **Phase 4** — Admin dashboard: seller & product moderation with notifications, platform analytics, category management, user block/unblock, order overview
- [x] **Phase 5** — Cart, addresses, checkout with atomic stock reservation, mock + Razorpay payment providers, order lifecycle with cancel/returns
- [x] **Phase 6** — AI Try-On: mock provider (free watermarked preview) + real FASHN provider auto-enabled by `FASHN_API_KEY`, rate limits + cost log, try-on history
- [x] **Phase 7** — AI product descriptions, review summaries, voice search, support chat — all behind one `AIService` (mock ↔ Claude via env key); reviews system
- [x] **Phase 8** — Referral rewards (₹100 on first paid order), notification center + bell, WhatsApp/SMS/email mock hooks, public order tracking, delivery partner stub with AWB
- [x] **Phase 9** — Rate limiting, upload/validation hardening, role-guard audit, SEO (robots/sitemap/OG), error pages, production Docker stack + Nginx + SSL + backups ([DEPLOYMENT.md](DEPLOYMENT.md))

🎉 **All 10 phases complete.** The platform is feature-complete and deployable.
