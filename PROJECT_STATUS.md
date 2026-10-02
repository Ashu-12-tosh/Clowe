# Clowe — Project Status

_Last updated: 2026-10-01 · commit `c32f093` · live at **cloweshop.com**_

This file is meant to stand on its own. Someone who reads only this should know
what Clowe is, what works, what is deliberately switched off, what is blocking a
real launch, and why parts of the code are shaped the way they are.

Clowe is a multi-vendor marketplace — shoppers, sellers and an admin — built as
an npm workspace monorepo: `apps/api` (Express + Prisma + Postgres),
`apps/web` (Next.js App Router), `packages/shared` (types, Zod schemas and the
logic both sides must agree on).

---

## Snapshot

| | |
|---|---|
| Database | 58 models, 46 migrations |
| API | 50 route modules |
| Web | 80 pages |
| Tests | **367 passing** — 205 unit, 162 integration |
| Build | `npm run build` passing; api + web typecheck clean |
| Deployed | Hostinger VPS, Docker Compose, HTTPS live |

**The platform is feature-complete and deployed.** What remains is not features:
it is three external providers that have been requested and not yet activated,
and a set of known gaps listed at the bottom.

---

## What is built and live

**Storefront** — category tree, product listing with filters and facets,
Postgres full-text search with a hand-written query parser (price bounds,
brands, sort, inferred category), a type-ahead with grouped suggestions,
product pages with zoom and variants, wishlist and shared wishlists, reviews,
public order tracking.

**Buyer** — phone-OTP login with JWT plus refresh rotation, cart, addresses,
checkout with atomic stock reservation, order lifecycle, cancellations, returns
and refunds, referral rewards, notification centre.

**Seller** — registration and approval, product CRUD with variants, **per-variant
images** (grouped by colour in the form — one upload set fans out to every
variant sharing that colour), inventory, orders, returns, promotions, store
page, support tickets, payouts view, **automated KYC verification** against
Cashfree's Verification Suite (PAN, GSTIN, bank account, with name-match
scoring and a billing-aware cache that never pays for the same answer twice).

**Admin** — seller moderation with KYC results and fraud flags, product
moderation, category management, order and return oversight, analytics, user
block/unblock, platform settings, audit log, support desk.

**AI** — try-on ("Try On Me"), product descriptions, review summaries, support
chat. All behind one service interface with mock ↔ real switching by env key.

**Mobile** — the storefront was audited and fixed at 360/390/414px. The codebase
was already mobile-first (base classes target small screens, `md:`/`lg:` scale
up); the defects were specific, not systemic. Header search now collapses to an
icon that opens a full-screen overlay reusing the same combobox, listing cards
say "from ₹499" when variants differ in price, and a repeatable check lives at
`scripts/responsive-check.mjs` — it asserts the page body never scrolls
sideways and the search box stays usable, and exits non-zero so it can gate CI.

**Voice search** takes the spoken transcript to `/products?q=...` and lets
`parseSearchQuery` read it — the same parser the typed box, the suggestions and
the results page share, so price bounds, brands and sort come along for free. It
used to call a second, weaker parser whose category guess was passed as a hard
filter; that is now a ranking hint, as the rule below requires. The mic is
hidden in Brave, which ships the speech API but not the service behind it: it
takes the microphone and reports `network` half a second later, every time.
Everywhere else every ending says what happened — including Chrome finishing
with neither a result nor an error — and a watchdog ends a recogniser that
never calls back. Two things the recogniser does to its output are handled:
the punctuation it adds ("Headphones.") no longer turns a category search
into the whole catalog, and a run that ends early searches the whole phrase
heard so far rather than the first segment of it. `scripts/voice-probe.mjs`
measures all of this in real Brave, Chrome and Edge — never through the real
microphone — and `--audio` plays recorded speech through them to measure
accuracy. What it found is under Known gaps.

**Coupons are built and switched off.** `couponsEnabled` in platform settings
defaults to `false`: every shopper-facing entry point is hidden and the API
refuses codes, while the table, the seeded codes, the routes, the tests and the
discount recorded against past orders all stay exactly as they are. Turning them
back on is one checkbox in admin settings. Seller promo codes are redeemed
through the same box, so sellers are blocked from creating a code while it is
off, rather than creating one nothing could redeem.

---

## Security

A full audit was run on 2026-09-28. **Exploit detail is deliberately not in this
file, because this repo is public.** The complete report — findings, reproduction
steps, severity reasoning and fix order — is in `SECURITY-AUDIT.local.md`, which
is ignored via `.git/info/exclude` and exists only on the working machine.

**Fixed and deployed**

- **#1 — cross-seller variant write** (critical). A seller could modify another
  seller's product variants. Fixed in two layers: an explicit ownership check,
  and the write itself scoped so a cross-product write matches nothing even if
  that check is ever lost. Four integration tests, verified by reverting the fix
  and watching them fail.
- **#4 — suspended sellers kept trading.** Suspension stopped new listings and
  nothing else. A blocked seller can no longer write anything; reads stay open
  so they can still see their orders, their money and the reason they were
  stopped, and the support channel stays open so a suspension can be appealed.
- **Checkout re-validation.** Checkout never re-read whether an item was still
  sellable, so a cart filled before a suspension still paid the suspended shop.

**Open**

- **#2 / #3 — two stored-XSS paths and no CSP on the web app** (high). One is
  reachable by a buyer, one by a seller. A single URL-scheme allow-list fixes
  both; a CSP header is defence in depth for whatever is missed.
- **#5 — the public order-tracking response includes courier tracking details**
  that can be used to recover information the response itself withholds
  (medium).
- **#6 — account enumeration** on two unauthenticated endpoints (medium).

**Accepted, not fixed**

- Access tokens are stateless, so blocking a user or demoting an admin takes
  effect at the next token refresh rather than instantly. Bounded by the token
  lifetime; a denylist would add a lookup to every authenticated request.

**Checked and sound** — admin authorization (every admin router guarded at the
router level), no customer-to-customer data leaks across 60+ handlers, no SQL
injection (the raw-SQL search work is parameterised throughout, and its ORDER BY
is a closed switch), payment webhook signatures verified with timing-safe
comparison, no path traversal in uploads, try-on spend capped per user and per
month.

---

## Launch blockers

These are the three things standing between the current site and real customers.
All three are waiting on an external party, not on code.

**1. OTP SMS — waiting on DLT registration.**
Login codes are printed to the API logs rather than texted, so **nobody except
the operator can sign in**. The provider interface exists at
`apps/api/src/services/otp/`; what is missing is the implementation and, before
that, DLT registration (the Indian regulatory step every transactional SMS
sender must complete). This is the single hard blocker on a public launch.

To read a login code today:
```sh
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f api | grep -A2 'MOCK OTP'
```

**2. Shipping — Delhivery One, replacing Shiprocket.**
The decision is Delhivery One; the integration is not written. The mock in
`apps/api/src/services/shipping/` fabricates AWB numbers, so tracking pages work
and no courier is booked. Orders can be shipped manually at low volume.

*RTO (courier returns an undelivered parcel to the seller) is designed, not
built; it lands with this integration. Decided on 2026-10-02: RTO is a set of
line statuses on the existing enum (RTO_INITIATED → RTO_IN_TRANSIT →
RTO_DELIVERED / RTO_LOST), triggered by the seller with a reason until the
courier webhook exists; a prepaid order is refunded when RTO is **initiated**,
not when the parcel is back; stock is restocked only on RTO_DELIVERED; the
seller bears the RTO shipping cost as a ledger entry, with forward and RTO
charges becoming separate typed entries once Delhivery reports them; repeat
RTOs are counted per customer and shown to admin, with no automatic block.*

**3. Cashfree — all four products requested, all pending activation.**
Payment Gateway, Payouts, Secure ID (KYC verification) and Easy Split (split
settlement to sellers) have been applied for and none is live yet. Until then:
payments run on the mock pay button, payouts are a mock, and **KYC runs on a
mock that marks every well-formed PAN, GSTIN and account as verified — which is
not a real check, and real sellers must not be approved against it.**

---

## Known gaps — real, not scheduled

Each is understood and none is urgent. They are written down so they are not
rediscovered as surprises.

**Product images load from a third party.** Live product images point at
`loremflickr.com`, so every image on every page is an external request — this is
the main reason pages feel slow. The demo images were meant to be downloaded
locally first; `npm run db:localize-images -w @clowe/api` does exactly that and
has not been run against production.

**Apparel and footwear priced ₹2,625.01–₹2,950 have no consistent GST rate —
needs a CA's confirmation before launch.** The 5% / 18% line is ₹2,500 per piece
*before* GST, but prices are entered GST-inclusive, and in this band the answer
is circular: at 18% the ex-GST value is under ₹2,500 (so 5%), at 5% it is over
(so 18%). The code charges 18%, never under-collects, and warns the seller that
₹2,625 or less would be 5%. Options to put to the CA: refuse prices in that band
for slab categories, or have sellers enter the ex-GST price for those categories
so the rate follows from it.

**TDS is withheld from the first rupee; the ₹5 lakh exemption is not applied.**
Under s.194-O(4), an individual or HUF seller who has furnished a PAN or
Aadhaar is exempt while their gross sales through us in the financial year stay
within ₹5 lakh.
We withhold 0.1% on every sale regardless. That over-deducts for small sellers
(refundable to them through their return, not lost) rather than under-deducting.
Applying it needs the seller's entity type and a running FY total per seller.
Settle the exact citation and conditions with the CA, as the new Income-tax Act
renumbers these sections.

**A seller without a PAN can be paid, at the 0.1% TDS rate.** PAN is optional at
registration, KYC never blocks approval (the admin can approve by acknowledging
the warnings), and a payout checks only that the seller is approved and the
payout method verified. Without a PAN, s.206AA makes the s.194-O rate 5%; we
withhold the single `payoutTdsPercent` for everyone, so the shortfall would be
the marketplace's. Approval does warn "PAN has not been provided", but the admin
can acknowledge it and approve. Either payouts should require a verified PAN,
or TDS should switch to 5% when none is on file.

**The shipping template does nothing yet.** Standard / Express / Heavy is saved
with a listing and shown back on the form, and nothing else reads it. It is left
as it is on purpose: it gets real meaning with the Delhivery integration (service
type and rate card). Weight and dimensions, by contrast, are checked: required in
range before anything goes to review (10 g–100 kg, each side 1–300 cm), with a
live volumetric-weight hint (L × W × H ÷ 5000) and a warning when the box weighs
more than twice the item by size.

**Two "Smartphones" categories.** The catalogue has one under *Mobiles* and
another under *Electronics*. This is why an inferred category may only rank
results and never filter them — filtering on a guessed slug would hide over half
of the matching phones. The duplication itself should be resolved.

**Bedding is an empty leaf.** A category under Home & Kitchen with no children
and no products — it appears in navigation and goes nowhere.

**The seller product form gives no hint that an option axis is needed.** With no
axis added, the Variants step shows a single unlabelled row and no prompt to add
"Colour" or "Size" first. This is not cosmetic: it led to a conclusion that
per-variant pricing did not exist, when it has always been built and required.
An empty state naming the next action would fix it.

**Price filter and price sort mean different variants.** The filter matches a
product when *any* variant falls in range; the sort and the displayed price use
the cheapest. So a ₹500 size shows up in a "₹1,500+" filter displaying ₹500.
Both halves are individually defensible, which is why it has survived — the
filter answers "is there something here in my budget", the sort answers "what
does this cost from". It needs a decision about which question the listing is
answering before it needs code.

**`manualOrderService` does not check seller status.** An admin placing a manual
order validates the product's status but never the seller's, so an order can be
placed against a suspended seller's product. Arguably the admin's prerogative —
they did the suspending — but it is now inconsistent with checkout, which
refuses the same thing. It should be a decision rather than an oversight.

**Seller identity documents are stored in plain text.** `bankAccountNo`,
`panNumber`, `gstNumber`, `panName`, `bankAccountName` and `bankIfsc` are plain
columns on `SellerProfile`. They are never over-exposed by the API — the account
number is masked to its last four digits everywhere it surfaces — and the KYC
check ledger correctly stores only HMAC fingerprints rather than the values. But
the profile columns themselves are unencrypted at rest.

**Voice recognition accuracy is the browser's, and it is not good enough for
real shoppers.** `recognition.lang` is `en-IN` and always has been; measured
in Chrome 154 with synthetic Indian and US voices (56 runs per setting),
en-IN and en-US gave the same transcript nearly every run — 68% vs 66% exact —
so the language setting is not the cause and is not the fix. Indian voices
reached 79% exact, US voices 54–57%. The misses are words we sell: kurti →
"curry" / "Scooty" / "pretty", boAt → "about your words", Redmi → "read my
note", and the right word was almost never among the alternatives the
recogniser offers, so picking a better alternative against the catalog gained
nothing when prototyped (18 of 112 transcripts changed, none improved). The
real production failures — "best mobile under 23,000" heard as "the best
moment under 23,000" — did not reproduce with synthetic speech; real voices
on phone microphones will do worse than these numbers, which are upper
bounds. Edge ignores `maxAlternatives` entirely and its en-IN model is worse
than its en-US one. hi-IN returns Devanagari, which the Latin-script catalog
cannot match; en-IN already returns Hinglish ("sasta phone dikhao") in Latin
script. Still-open parser gaps: "25000 rupees" leaves "rupees" as a keyword,
"phone in 25k" and number words give no price bound, and "under 23" with the
thousand dropped becomes a ₹23 cap.

*After launch, in this order:* server-side speech-to-text behind a flag,
Brave and Firefox first since the browser API cannot serve them — the browser
records with `MediaRecorder`, our API forwards the clip. Sarvam Saaras in
transliteration mode is the first candidate (Hinglish in Latin script, data
in India, about ₹33 per 1,000 four-second searches); Azure in Central India
is the English fallback at about ₹38. Choose by bake-off on 20–30 real
recordings from real phones, scored on whether the right product is found,
not on word error rate — `voice-probe.mjs --audio` plays any WAV through
Chrome for the same comparison. It needs a consent notice under the DPDP
rules and a per-user rate limit. Then vocabulary boosting for brand and
product words through the provider, and the parser gaps above. Not worth
doing: changing `lang`, alternative picking, Chrome's on-device recognition
(no en-IN pack, and Brave disables it), or Whisper in the browser (41–563 MB
download).

**Uploads live only on the VPS disk.** Product images, seller documents and
packing videos are written to a Docker volume. The nightly backup includes them,
and that backup is the only copy — images are the one kind of data here that
cannot be regenerated. Moving to S3-compatible storage is post-launch work.

---

## Production

Clowe runs on a **Hostinger VPS (KVM 2 or better)** at **cloweshop.com**, served
over HTTPS with a Let's Encrypt certificate and an HTTP→HTTPS redirect. The
whole stack is one Docker Compose file — Postgres, the API, the Next.js web app
and Nginx — defined in `docker-compose.prod.yml` and configured by
`.env.production` on the server (never committed; `.env.production.example`
lists all 23 variables it reads). Database migrations run automatically when the
API container starts. A nightly cron takes a Postgres dump plus the uploads
volume into `backups/`, keeping 14 days. **To deploy a change: `git pull` then
`docker compose -f docker-compose.prod.yml --env-file .env.production up -d
--build`.** The step-by-step first-deploy guide, with the expected output at
every step and rollback procedures, is **[DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md)**;
[DEPLOYMENT.md](DEPLOYMENT.md) explains why the stack is shaped the way it is.

Two deploy-time facts worth knowing before changing anything: `SITE_URL` is
compiled into the web bundle, so changing it requires a rebuild rather than a
restart; and `KYC_FINGERPRINT_SECRET` must be set once and never rotated,
because a new key makes every verified document look changed and re-bills every
verification.

---

## Decisions that shaped the code

These recur throughout the codebase. They explain why things are written the way
they are, and are easy to undo by accident if the reasoning is not known.

**A guess may rank, but it must never filter.** The search parser infers a
category from a query and carries it as `inferredCategorySlug`, deliberately not
`categorySlug`. An inferred category boosts ranking; only a shopper's explicit
choice removes products. The catalogue keeps Smartphones under two different
parents, so filtering on a guess hides most of the matching products. Voice
search violated this for months by passing its guessed category as a hard
filter — which is what the rule exists to prevent.

**Measure; do not guess.** Layout and performance claims are checked against a
running browser, not reasoned about. Doing this found that the mobile table
"scroll problem" was not a scroll problem, that a popover was widening the
container it lived in, and that a speech recogniser can take a microphone
permission and then never call back at all. Several confident hypotheses — two
of them in writing — turned out to be wrong when measured.

**Make a bad state structurally impossible rather than remembered.** Where a
rule could be enforced either by a check or by the shape of the code, prefer the
shape. Ownership lives in the `where` clause rather than in a guard above it;
variant images live in their own table rather than as a nullable column on a
shared one, because forty existing queries would otherwise each need a filter
they do not have; the suspended-seller guard keys on the HTTP method so a route
added later inherits it. The cross-seller bug happened precisely because one
statement carried the constraint and the statement beside it did not.

**A test that cannot fail is not a test.** Every regression guard here was
verified by breaking the code and watching the test go red. This caught a test
that passed against both the fixed and the broken version, and a measurement
script that reported the same number at every screen width.

**Hide a feature; do not delete it.** Coupons are switched off behind a flag
with everything intact, so restoring them is a setting rather than a rebuild.
The same reasoning keeps the AI search-intent endpoint routed and tested even
though nothing calls it today.

**Absent is not the same as empty.** An omitted field means "leave this alone";
an empty one means "the user cleared it". This distinction is what stops a price
edit from deleting images somebody uploaded, and is relied on wherever a partial
update is possible.
