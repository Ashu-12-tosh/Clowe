# Clowe — Production Deployment Guide (Hostinger VPS)

Deploys the full stack with Docker Compose: **Postgres + API + Next.js web + Nginx**, all on one VPS. Works on any Ubuntu VPS (Hostinger KVM 2 or better recommended: 2+ vCPU, 4+ GB RAM).

> **Doing the deploy right now?** Work through **[DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md)**
> instead — the same deploy as a paste-through checklist, with the expected
> output at every step, an up-front check that the database can create its
> extensions (if it cannot, the API never starts), rollback procedures, and
> exactly which features are non-functional until real provider keys are set.
>
> This file is the reference: what each piece is and why it is shaped this way.

---

## 1. Prepare the VPS

SSH in as root (Hostinger dashboard → VPS → SSH access):

```bash
ssh root@YOUR_VPS_IP

# Install Docker (includes Compose v2)
curl -fsSL https://get.docker.com | sh

# Basic firewall
apt-get install -y ufw git
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

## 2. Point your domain

In your DNS provider (Hostinger → Domains → DNS):

| Type | Name | Value |
|---|---|---|
| A | `@` | YOUR_VPS_IP |
| A | `www` | YOUR_VPS_IP |

## 3. Get the code onto the VPS

```bash
cd /root
git clone <your-repo-url> clowe && cd clowe
# (or: rsync -av --exclude node_modules --exclude .next ./ root@VPS_IP:/root/clowe/ from your machine)
```

## 4. Configure production env

```bash
cp .env.production.example .env.production
nano .env.production
```

**Required values** (the compose file refuses to start without them):

- `SITE_URL=https://yourdomain.com`
- `POSTGRES_PASSWORD` → `openssl rand -hex 24`
- `JWT_ACCESS_SECRET` → `openssl rand -hex 32`
- `ADMIN_PHONE` → your login number

Then edit `nginx/nginx.conf` and replace `yourdomain.com` with your domain (2 places in the HTTP block; the HTTPS block is used in step 6).

> ⚠️ Until you configure a real OTP provider, login OTPs print in the API logs:
> `docker compose -f docker-compose.prod.yml logs -f api | grep OTP`

## 5. First launch

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

First build takes a few minutes. Then:

```bash
# Check all 4 containers are up
docker compose -f docker-compose.prod.yml ps

# Migrations ran automatically on API start. Seed the admin + demo catalog:
docker compose -f docker-compose.prod.yml exec api npx tsx prisma/seed.ts   # if tsx missing, see note below

# Health check
curl http://localhost/api/health
```

Visit `http://yourdomain.com` — the store should load. 🎉

> **Seed note:** the production image prunes dev dependencies, so if `tsx` is unavailable run the seed from your laptop against the VPS DB instead: temporarily add `ports: ["5433:5432"]` to the `db` service, then run `DATABASE_URL=postgresql://clowe:PASSWORD@VPS_IP:5433/clowe npm run db:seed -w @clowe/api` locally, and remove the port again. Seeding is optional — it creates the admin user (which you can also get by registering with `ADMIN_PHONE`... the seed is the supported way) and demo catalog.

## 6. Enable HTTPS (Let's Encrypt)

```bash
# Issue certificates (nginx already serves the challenge path)
docker run --rm \
  -v clowe_certbot_certs:/etc/letsencrypt \
  -v clowe_certbot_www:/var/www/certbot \
  certbot/certbot certonly --webroot -w /var/www/certbot \
  -d yourdomain.com -d www.yourdomain.com \
  --email you@example.com --agree-tos --no-eff-email

# Enable the HTTPS block
nano nginx/nginx.conf   # uncomment the 443 server block + the HTTP→HTTPS redirect
docker compose -f docker-compose.prod.yml restart nginx
```

Auto-renewal (certificates last 90 days) — add to crontab (`crontab -e`):

```
0 4 * * 1 docker run --rm -v clowe_certbot_certs:/etc/letsencrypt -v clowe_certbot_www:/var/www/certbot certbot/certbot renew --webroot -w /var/www/certbot && docker compose -f /root/clowe/docker-compose.prod.yml restart nginx
```

## 7. Backups

```bash
chmod +x scripts/backup-db.sh
./scripts/backup-db.sh          # test it — creates backups/db-*.sql.gz + uploads-*.tar.gz

crontab -e                       # nightly at 2 AM, keep 14 days:
# 0 2 * * * cd /root/clowe && ./scripts/backup-db.sh >> backups/backup.log 2>&1
```

Copy backups off the VPS periodically (e.g. `rsync -av root@VPS_IP:/root/clowe/backups/ ./clowe-backups/` from your machine, or push to any S3-compatible bucket).

## 8. Updating the app

```bash
cd /root/clowe
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Migrations run automatically when the API container starts. Zero data is lost — the DB and uploads live in named volumes.

## 9. Going fully live — provider checklist

| Feature | Env change | Where to get it |
|---|---|---|
| Real payments | `PAYMENT_PROVIDER=razorpay` + `RAZORPAY_KEY_ID/KEY_SECRET` (live keys) + webhook secret; add webhook `https://yourdomain.com/api/payments/webhook` in the Razorpay dashboard (event: payment.captured/failed) | razorpay.com |
| Real OTP SMS | Implement + set `OTP_PROVIDER` (MSG91/Twilio) — interface ready in `apps/api/src/services/otp/` | msg91.com |
| Real AI try-on | `FASHN_API_KEY=...` (auto-enables) | fashn.ai |
| Real AI features | `ANTHROPIC_API_KEY=...` (auto-enables) | platform.claude.com |
| WhatsApp/SMS/email | Implement + set `MESSAGING_PROVIDER` — interface in `services/messaging/` | Gupshup / MSG91 |
| Delivery partner | Implement + set `SHIPPING_PROVIDER` — interface in `services/shipping/` | shiprocket.in |
| Object storage | Move `uploads/` to S3-compatible storage (interface point: `routes/uploads.ts`) | any S3 provider |

## Troubleshooting

| Symptom | Check |
|---|---|
| 502 from Nginx | `docker compose -f docker-compose.prod.yml logs api web` — a container is down |
| Login OTP not arriving | Mock mode — `docker compose ... logs api \| grep OTP` |
| Images not loading | `SITE_URL` must match the domain (image URLs are built from it); rebuild web after changing it |
| DB connection refused | `docker compose ... ps` — is `db` healthy? Password changed after first boot requires wiping the `db_data` volume or updating the user manually |
| CORS errors | `SITE_URL` (→ `CORS_ORIGINS`) must exactly match the browser origin, including `https://` |
