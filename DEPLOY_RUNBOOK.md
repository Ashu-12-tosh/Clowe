# Clowe — Deploy Runbook

_A paste-through checklist for a first deploy to a Hostinger VPS (or any Ubuntu
Docker host). Work through it top to bottom. Every step says what a correct
result looks like — if you do not see it, stop and read the ❌ line before
continuing._

[DEPLOYMENT.md](DEPLOYMENT.md) explains *why* the stack is shaped this way.
This file is the *what to type*, in order.

---

## Read this before you start

Three things that will otherwise look like bugs:

1. **OTP login will only work for you.** There is no real SMS provider wired
   yet. Login codes are printed to the API log instead of being texted. You
   can log in by reading the log; nobody else can log in at all. **This is
   expected, not a broken deploy.** See [§8](#8-what-works-on-mocks-and-what-does-not).
2. **Nothing on the mock providers costs money or crashes the stack.** Every
   unset provider key falls back to a free, local, no-network mock. Confirmed
   per provider in [§8](#8-what-works-on-mocks-and-what-does-not).
3. **Step 1 is a gate.** If the database user cannot create the `pg_trgm` and
   `unaccent` extensions, `prisma migrate deploy` halts, and because the API
   container's start command is `migrate deploy && node dist/index.js`, the API
   never starts at all. You would spend 20 minutes building images for a stack
   that cannot boot. So it is checked first, before anything is built.

---

## 0. Get to the point where the gate can run

Nothing is built in this section. It is the minimum needed to run Step 1.

### 0.1 — SSH in and install Docker

```sh
ssh root@YOUR_VPS_IP

curl -fsSL https://get.docker.com | sh
apt-get install -y ufw git
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

✅ **Correct result:** `docker --version` prints `Docker version 2x.x.x`, and
`docker compose version` prints `Docker Compose version v2.x.x`.

❌ **If `docker compose` says "is not a docker command":** you have the old
standalone `docker-compose`. This runbook needs Compose v2. Re-run the
`get.docker.com` script.

> **VPS size:** KVM 2 or better (2+ vCPU, 4+ GB RAM). The Next.js build is the
> memory peak — on 1 vCPU / 2 GB it gets OOM-killed partway through Step 3.2.

### 0.2 — Point DNS at the VPS

In Hostinger → Domains → DNS:

| Type | Name | Value |
|---|---|---|
| A | `@` | YOUR_VPS_IP |
| A | `www` | YOUR_VPS_IP |

```sh
dig +short yourdomain.com
```

✅ **Correct result:** your VPS IP, on its own line.

❌ **If empty or the wrong IP:** DNS has not propagated. Carry on with the rest
— it only has to be right by Step 6 (the certificate). It does not block the
build.

### 0.3 — Clone the repo

```sh
cd /root
git clone https://github.com/Ashu-12-tosh/Clowe.git clowe
cd /root/clowe
```

✅ **Correct result:** `ls` shows `docker-compose.prod.yml`, `apps`, `nginx`.

> **The directory name matters.** Docker Compose names volumes after it:
> `/root/clowe` gives you `clowe_db_data`, `clowe_uploads_data`,
> `clowe_certbot_certs`. The backup script and the certbot commands below all
> assume `clowe`. If you clone somewhere else, adjust those names.

### 0.4 — A shortcut for the rest of this file

Every compose command needs the same two flags. Set this once:

```sh
cd /root/clowe
alias dc='docker compose -f docker-compose.prod.yml --env-file .env.production'
```

> ⚠️ **An alias dies when you disconnect.** If you reconnect over SSH, re-run
> both lines above before pasting any `dc ...` command. The rollback section
> ([§7](#7-rollback)) is written out in full for exactly this reason.

### 0.5 — Fill in the environment

```sh
cp .env.production.example .env.production
nano .env.production
```

Use the table in [§2](#2-environment-reference) to fill it. You need four
values before the gate will run. Generate three of them:

```sh
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "JWT_ACCESS_SECRET=$(openssl rand -hex 32)"
echo "KYC_FINGERPRINT_SECRET=$(openssl rand -hex 32)"
```

Paste those three into `.env.production`, and set `SITE_URL` and `ADMIN_PHONE`
by hand.

✅ **Correct result:** these five all print a value:

```sh
grep -E '^(SITE_URL|POSTGRES_PASSWORD|JWT_ACCESS_SECRET|KYC_FINGERPRINT_SECRET|ADMIN_PHONE)=' .env.production
```

❌ **If any line shows `KEY=` with nothing after it:** go back and fill it.
Steps 1 and 3 will both fail on a blank one.

---

## 1. 🚩 GATE — can the database create its extensions?

**Run this before building anything.** It starts only the Postgres container —
no image is built, nothing is compiled.

```sh
dc up -d db
```

✅ **Correct result:** `Container clowe-db-1  Started`.

❌ **If it says `set POSTGRES_PASSWORD in .env.production`:** §0.5 is
incomplete. Compose refuses to start rather than booting a passwordless
database. Fix it and re-run.

Wait for the health check to pass, then run the gate:

```sh
dc exec db psql -U clowe -d clowe -c \
  "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent; SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm','unaccent') ORDER BY extname;"
```

> If you changed `POSTGRES_USER` or `POSTGRES_DB` from the defaults, use your
> values in place of `-U clowe -d clowe`.

✅ **Correct result — exactly this, two rows:**

```
 extname
---------
 pg_trgm
 unaccent
(2 rows)
```

**You may continue.** Creating the extensions here is harmless — the migration
uses `CREATE EXTENSION IF NOT EXISTS` and will simply find them already there.

❌ **If you see `ERROR: permission denied to create extension "pg_trgm"`**
(usually with `HINT: Must be superuser to create this extension`):

**Stop. Do not build.** Migration `20260914120000_product_search_fts` will
abort, `migrate deploy` will exit non-zero, and the API container will
crash-loop without ever listening. Every later step in this runbook would fail
in a confusing way.

This only happens when `DATABASE_URL` points at a database you do not own —
a managed Postgres, or a role someone else provisioned. The bundled `db`
service creates `POSTGRES_USER` as a superuser, so it cannot happen there.
Fix it one of two ways:

```sh
# a) Grant it, as a superuser on that server:
psql -U <superuser> -d clowe -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent;'

# b) Or drop the external database and use the bundled one (remove any
#    DATABASE_URL override from .env.production), then re-run the gate.
```

❌ **If you see `database "clowe" does not exist`:** Postgres was still
initialising. Give it a few seconds and re-run. Check with `dc ps` — the `db`
row should read `(healthy)`.

❌ **If you see `is not running`:** `dc logs db` will say why. A password
changed after the volume was first created is the usual cause — see
[§7.4](#74-the-database-is-wrong-and-you-have-a-backup).

---

## 2. Environment reference

All of these live in `.env.production`, read by
`docker compose --env-file .env.production`.

### 2.1 — Required: the stack will not start without them

Compose checks these itself and refuses to start, naming the missing one.

| Variable | What it is | If missing |
|---|---|---|
| `SITE_URL` | Public URL, **no trailing slash**. Becomes CORS origin, image URLs, and both web build args. | Compose aborts: `set SITE_URL in .env.production` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` | Compose aborts: `set POSTGRES_PASSWORD in .env.production` |
| `JWT_ACCESS_SECRET` | `openssl rand -hex 32`. **Minimum 16 characters.** | Compose aborts. If set but shorter than 16, compose starts and the **API crash-loops** on a Zod error. |
| `KYC_FINGERPRINT_SECRET` | `openssl rand -hex 32`. **Minimum 32 characters in production.** | Compose aborts. If set but shorter than 32, the **API crash-loops** on a Zod error. |

> ⚠️ **`KYC_FINGERPRINT_SECRET` is set once and never rotated.** It keys the
> fingerprints that say whether a PAN, GSTIN or bank account changed since it
> was verified. A new key makes every one of them look changed, and every
> seller gets re-verified — and, once Cashfree is live, re-billed.

### 2.2 — Strongly recommended

| Variable | What it is | If missing |
|---|---|---|
| `ADMIN_PHONE` | Your 10-digit login number. Must match `^[6-9]\d{9}$` — **no `+91`, no spaces, no dashes.** | Stack starts fine, but the seed skips admin creation and **you have no way to log in as admin**. If it is set in a wrong format, the **API crash-loops** on a Zod error. |

### 2.3 — Optional: unset means mock

Every one of these may be left blank. Blank is read as "not configured", not
as a malformed value — the stack starts normally either way.

| Variable | Default | Effect when blank |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_DB` | `clowe` / `clowe` | Fine as-is |
| `OTP_PROVIDER` | `mock` | OTP printed to the API log |
| `PAYMENT_PROVIDER` | `mock` | Fake pay button; no real charge |
| `RAZORPAY_KEY_ID` / `_KEY_SECRET` / `_WEBHOOK_SECRET` | — | Ignored while `PAYMENT_PROVIDER=mock` |
| `KYC_PROVIDER` | `auto` | Mock, because no Cashfree keys are set |
| `CASHFREE_VERIFICATION_ENV` | `sandbox` | Sandbox never bills |
| `CASHFREE_VERIFICATION_CLIENT_ID` / `_SECRET` | — | Both blank → mock. **Exactly one set → mock, with a warning in the log** |
| `CASHFREE_VERIFICATION_PUBLIC_KEY` | — | Only needed for signature 2FA |
| `TRYON_PROVIDER` / `FASHN_API_KEY` | `auto` / — | Free watermarked mock try-on |
| `AI_PROVIDER` / `ANTHROPIC_API_KEY` | `auto` / — | Canned mock AI text |
| `MESSAGING_PROVIDER` | `mock` | Messages printed to the API log |
| `SHIPPING_PROVIDER` | `mock` | Fabricated AWB numbers |

### 2.4 — Build args (web image only)

You do **not** set these by hand. `docker-compose.prod.yml` passes both from
`SITE_URL`:

| Build arg | Source | Baked in at |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `${SITE_URL}` | **build time** |
| `NEXT_PUBLIC_SITE_URL` | `${SITE_URL}` | **build time** |

> ⚠️ **These cannot be changed by restarting.** They are compiled into the
> browser bundle. `NEXT_PUBLIC_SITE_URL` ends up in `sitemap.xml`, `robots.txt`
> and the OG tags; `NEXT_PUBLIC_API_URL` is the host every browser request goes
> to. **Changing `SITE_URL` later means a full rebuild of the web image**
> (`dc up -d --build web`), not a restart.

The build fails loudly rather than shipping a wrong image: `next.config.mjs`
rejects an unset value *and* a `localhost` one whenever the Dockerfile marks
the build as deployable. See the ❌ in [§3.2](#32-build-and-start-everything).

---

## 3. Build and start

### 3.1 — Set your domain in the Nginx config

```sh
nano nginx/nginx.conf
```

Replace both occurrences of `yourdomain.com` on the `server_name` line with
your domain. Leave the commented-out HTTPS block alone — Step 6 handles it.

✅ **Correct result:**

```sh
grep server_name nginx/nginx.conf
```

shows your real domain, not `yourdomain.com`.

### 3.2 — Build and start everything

```sh
dc up -d --build
```

This builds two images and starts four containers. **Expect 10–25 minutes** on
a 2 vCPU box; most of it is the Next.js build. It is not stuck.

✅ **Correct result:** the last lines read

```
 ✔ Container clowe-db-1     Healthy
 ✔ Container clowe-api-1    Started
 ✔ Container clowe-web-1    Started
 ✔ Container clowe-nginx-1  Started
```

❌ **If the web build fails with `NEXT_PUBLIC_SITE_URL is not set` or
`points at the build machine`:** `SITE_URL` in `.env.production` is blank or
still says `localhost`. This guard exists so you get a failed build instead of
a site that loads and then does nothing. Fix `SITE_URL` and re-run.

❌ **If the build is killed around the web step with no error:** out of memory.
Check with `dmesg | tail`. Either resize the VPS, or add swap:

```sh
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
```

### 3.3 — Confirm all four containers stayed up

```sh
dc ps
```

✅ **Correct result:** four rows — `db` `(healthy)`, and `api`, `web`, `nginx`
all `Up`.

❌ **If `api` shows `Restarting`:** it is crash-looping. Read the reason:

```sh
dc logs api | tail -30
```

| What the log says | Cause | Fix |
|---|---|---|
| `JWT_ACCESS_SECRET must be at least 16 chars` | Secret too short | Regenerate with `openssl rand -hex 32` |
| `KYC_FINGERPRINT_SECRET (32+ characters) is required in production` | Missing or too short | Regenerate with `openssl rand -hex 32` |
| `invalid_string` on `ADMIN_PHONE` | Has `+91`, spaces or dashes | 10 digits only, starting 6–9 |
| `permission denied to create extension` | You skipped the gate | Go back to [§1](#1--gate--can-the-database-create-its-extensions) |
| `Can't reach database server` | DB not healthy yet | `dc logs db`; usually resolves on its own |

After any `.env.production` edit: `dc up -d api` to pick it up.

### 3.4 — Seed the admin account and demo catalog

```sh
dc exec api npx tsx prisma/seed.ts
```

✅ **Correct result:** lines ending with `[seed] Categories ready: ...`,
`[seed] Products created: ...`, `[seed] Rating cache synced ...`.

❌ **If it says `tsx: not found`:** the production image prunes dev
dependencies. Seed from your laptop against the VPS database instead — the
workaround is in [DEPLOYMENT.md §5](DEPLOYMENT.md).

❌ **If it says `[seed] ADMIN_PHONE not set in .env — skipping admin
creation`:** you have no admin account. Set `ADMIN_PHONE` in
`.env.production`, run `dc up -d api`, and re-run the seed.

---

## 4. Verify it actually works

Four checks, in this order. Each one rules out a different layer.

### 4.1 — API is alive and can reach the database

```sh
curl -s http://localhost/api/health
```

✅ **Correct result:**

```json
{"success":true,"data":{"status":"ok","service":"clowe-api","version":"0.1.0","timestamp":"...","database":"up"}}
```

`"database":"up"` is the part that matters.

❌ **`"database":"down"`:** API is running but Postgres is not reachable.
`dc logs db`.

❌ **`502 Bad Gateway`:** the API container is down. `dc ps`, then
[§3.3](#33-confirm-all-four-containers-stayed-up).

❌ **`Connection refused`:** nginx is down. `dc logs nginx` — almost always a
syntax error from editing `nginx.conf` in §3.1.

### 4.2 — A page renders

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/
```

✅ **Correct result:** `200`

Then open `http://yourdomain.com` in a browser. The storefront should load
with product images.

❌ **Page loads but every image is broken:** `SITE_URL` does not match the
domain you are browsing. Image URLs are built from it. Fix `SITE_URL` and
**rebuild** (`dc up -d --build web`) — a restart will not do it.

❌ **Page loads but nothing works and the browser console shows CORS errors:**
`SITE_URL` must match the browser's origin *exactly*, including `https://` and
with no trailing slash.

### 4.3 — Search returns results

This is the real proof that the extensions and the full-text index from Step 1
survived the migration.

```sh
curl -s "http://localhost/api/products?q=marigold" | head -c 300
```

✅ **Correct result:** JSON starting `{"success":true,` with a non-empty
`items` array — `Marigold` is one of the seeded brands.

```sh
# Just the count, if that is easier to read:
curl -s "http://localhost/api/products?q=marigold" | grep -o '"total":[0-9]*'
```

✅ **Correct result:** `"total":` followed by a number greater than 0.

❌ **`"total":0` while the homepage clearly shows products:** the search vector
did not populate. Confirm the extensions are really there:

```sh
dc exec db psql -U clowe -d clowe -c "SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm','unaccent');"
```

❌ **`Category not found` or a 404:** you passed a `category` param by mistake.
Use the URL exactly as written.

### 4.4 — Admin login

**This is the step that looks broken and is not.** There is no SMS provider,
so the code is printed to the log rather than texted.

Open a log stream in a second SSH session and leave it running:

```sh
cd /root/clowe
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f api | grep -A2 'MOCK OTP'
```

Then, in the browser: go to `http://yourdomain.com/login` and enter the number
you put in `ADMIN_PHONE`.

✅ **Correct result:** the log stream prints

```
[clowe-api] ===== MOCK OTP =====
[clowe-api] Phone: +91 9999999999
[clowe-api] OTP:   123456
```

Type that code into the browser. You should land on the storefront, logged in,
with the admin area reachable at `/admin`.

❌ **No OTP block appears in the log:** the request never reached the API.
Check `dc logs api | tail -20` for an error.

❌ **`Invalid OTP`:** codes expire after 5 minutes and allow 5 attempts. Ask
for a new one.

❌ **You log in but `/admin` returns 403:** the seed did not give your number
the ADMIN role. Confirm `ADMIN_PHONE` matches what you typed exactly, then
re-run [§3.4](#34-seed-the-admin-account-and-demo-catalog) — the seed promotes
an existing user to ADMIN, so it is safe to re-run.

---

## 5. Backups — set this up before you have data worth losing

```sh
chmod +x scripts/backup-db.sh
./scripts/backup-db.sh
```

✅ **Correct result:** `[backup] done: db-<stamp>.sql.gz + uploads-<stamp>.tar.gz (keeping 14 days)`,
and `ls -lh backups/` shows two non-empty files.

❌ **`no such volume`:** your directory is not named `clowe`, so the volume
prefix differs. `docker volume ls | grep uploads` shows the real name.

Then schedule it — `crontab -e`:

```
0 2 * * * cd /root/clowe && ./scripts/backup-db.sh >> backups/backup.log 2>&1
```

Copy backups off the VPS regularly. A backup that only exists on the machine
you are backing up is not a backup:

```sh
# from your own machine
rsync -av root@YOUR_VPS_IP:/root/clowe/backups/ ./clowe-backups/
```

---

## 6. HTTPS

Only once `dig +short yourdomain.com` returns your VPS IP.

```sh
docker run --rm \
  -v clowe_certbot_certs:/etc/letsencrypt \
  -v clowe_certbot_www:/var/www/certbot \
  certbot/certbot certonly --webroot -w /var/www/certbot \
  -d yourdomain.com -d www.yourdomain.com \
  --email you@example.com --agree-tos --no-eff-email
```

✅ **Correct result:** `Successfully received certificate.` and a path under
`/etc/letsencrypt/live/yourdomain.com/`.

❌ **`Timeout during connect` / challenge failed:** port 80 is not reaching
nginx. Check `ufw status` allows 80, and `dc ps` shows nginx up.

❌ **`too many certificates already issued`:** Let's Encrypt rate limit — 5 per
domain per week. Wait, or use `--dry-run` while debugging.

Then enable it:

```sh
nano nginx/nginx.conf     # uncomment the 443 server block and the HTTP→HTTPS redirect
dc restart nginx
curl -sI https://yourdomain.com | head -1
```

✅ **Correct result:** `HTTP/2 200`

Add renewal to `crontab -e` (certificates last 90 days):

```
0 4 * * 1 docker run --rm -v clowe_certbot_certs:/etc/letsencrypt -v clowe_certbot_www:/var/www/certbot certbot/certbot renew --webroot -w /var/www/certbot && docker compose -f /root/clowe/docker-compose.prod.yml restart nginx
```

> **After HTTPS works, change `SITE_URL` to `https://...` and rebuild the web
> image** — `dc up -d --build web`. Until you do, image URLs and OG tags still
> say `http://`.

---

## 7. Rollback

Written out in full, because you may be reading this in a fresh SSH session
where the `dc` alias does not exist.

### 7.1 — Restart a single container first

Most problems are not worth a rollback.

```sh
cd /root/clowe
docker compose -f docker-compose.prod.yml --env-file .env.production restart api
docker compose -f docker-compose.prod.yml --env-file .env.production logs --tail 50 api
```

### 7.2 — Stop everything (data is kept)

```sh
cd /root/clowe
docker compose -f docker-compose.prod.yml --env-file .env.production down
```

✅ Containers removed. **Named volumes — the database and uploads — survive.**
`docker compose ... up -d` brings it all back with data intact.

> 🚨 **Never run `down -v` unless you mean it.** The `-v` flag deletes
> `db_data`, `uploads_data` and your certificates. There is no undo.

### 7.3 — Go back to the previous code

```sh
cd /root/clowe
git log --oneline -5          # note the SHA you want
git checkout <previous-sha>
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

⚠️ **Read this before rolling back across a migration.** Prisma migrations are
forward-only — `migrate deploy` has no `down`. What this means in practice:

- **The database is not rolled back by checking out old code.** New tables and
  columns stay. That is usually harmless: both recent migrations
  (`20260918120000_seller_kyc_checks` and `20260914120000_product_search_fts`)
  are **additive only**, so older code simply ignores what it does not know
  about.
- **A migration that removed or renamed something is different.** Old code will
  break against the new schema, and the only clean fix is restoring the
  database from a backup — [§7.4](#74-the-database-is-wrong-and-you-have-a-backup).
- The FTS migration keeps a commented-out down-migration at the bottom of its
  `.sql` file if you ever need to unwind it by hand.

### 7.4 — The database is wrong and you have a backup

```sh
cd /root/clowe
ls -lh backups/

# Restore the database (this overwrites current data):
gunzip -c backups/db-YYYYMMDD-HHMMSS.sql.gz | \
  docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec -T db sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'

# Restore uploaded images:
docker run --rm \
  -v clowe_uploads_data:/uploads \
  -v /root/clowe/backups:/backup \
  alpine tar xzf /backup/uploads-YYYYMMDD-HHMMSS.tar.gz -C /uploads

docker compose -f docker-compose.prod.yml --env-file .env.production restart api
```

### 7.5 — Start completely over

Only on a deploy with no real data yet.

```sh
cd /root/clowe
docker compose -f docker-compose.prod.yml --env-file .env.production down -v
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

🚨 Deletes the database, uploads **and certificates**. You will re-issue the
certificate — mind the Let's Encrypt weekly limit.

---

## 8. What works on mocks, and what does not

You have no real provider keys. Here is exactly what that means.

**Nothing below makes a network call, and nothing below can spend money.**
Every mock is local, free and deterministic. None of them can crash the stack:
a blank key is read as "not configured", not as a malformed value, so the API
boots normally. The one case that *does* refuse to boot is a malformed
Cashfree 2FA public key — and that is deliberate, because the fallback would be
the mock, and silently approving sellers on fake checks is worse than not
starting.

| Feature | On the mock | Costs money? | Safe to demo? |
|---|---|---|---|
| **Login OTP** | Code printed to the API log, not sent by SMS | No | **You only** — see below |
| **Payments** | Fake "Pay" button settles the order via `/api/payments/mock-pay`. Real order records, no real charge. | No | Yes |
| **Refunds** | Returns a fake refund id; order marks refunded | No | Yes |
| **Seller KYC** | **Marks every well-formed PAN/GSTIN/account as verified.** Not a real check. | No | Yes, but do **not** approve real sellers on it |
| **AI try-on** | Composites the photo and garment into a watermarked SVG preview | No | Yes |
| **AI features** (descriptions, review summaries, voice search, support chat) | Canned text | No | Yes |
| **WhatsApp / SMS / email** | Printed to the API log | No | Nothing is delivered |
| **Shipping** | Fabricates an AWB number | No | Tracking pages work, no courier is booked |
| **Payouts** | Mock only | No | No money moves |

The API says which providers are live at boot:

```sh
dc logs api | grep 'clowe-api\]' | head -20
```

✅ **Expected on mocks:**

```
[clowe-api] listening on http://localhost:4000 (production)
[clowe-api] KYC: mock provider — checks are not real (set the Cashfree verification keys)
```

That KYC warning is correct and expected. It is telling you the truth.

### ⚠️ OTP login: only you can log in

**Say it plainly: until an SMS provider is written, the site is live but nobody
can sign up or log in except you, by reading the server log.**

This is not a broken deploy and there is no configuration that fixes it — the
real provider does not exist in the code yet. `OTP_PROVIDER` only accepts
`mock` today; `apps/api/src/services/otp/` has the interface ready and no
MSG91/Twilio implementation behind it.

Everything else on the site works: browsing, search, product pages, cart,
checkout on the mock gateway, the seller dashboard and the admin area — all of
it, for you, once you are logged in.

**So treat this deploy as a staging environment on a real domain.** Do not
advertise it until [PROJECT_STATUS.md](PROJECT_STATUS.md) §"After going live"
item 1 is done.

---

## Quick reference

```sh
cd /root/clowe
alias dc='docker compose -f docker-compose.prod.yml --env-file .env.production'

dc ps                      # what is up
dc logs -f api             # follow API logs
dc logs -f api | grep -A2 'MOCK OTP'   # catch a login code
dc up -d --build           # rebuild and restart everything
dc up -d --build web       # rebuild web only (after changing SITE_URL)
dc restart nginx           # after editing nginx.conf
dc down                    # stop, keep data
./scripts/backup-db.sh     # back up now
```

### Updating the app later

```sh
cd /root/clowe
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Migrations run automatically when the API container starts. The database and
uploads live in named volumes, so nothing is lost.
