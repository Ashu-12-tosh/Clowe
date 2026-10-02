#!/bin/sh
# Clowe — nightly Postgres + uploads backup (public and private files).
# Usage (on the VPS, from the repo directory):  ./scripts/backup-db.sh
# Cron (2 AM daily):  0 2 * * * cd /root/clowe && ./scripts/backup-db.sh >> backups/backup.log 2>&1
set -eu

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

# 1. Database dump (compressed) from the running db container
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz"

PROJECT="$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"

# 2. Uploaded images volume (public: catalog images, logos, avatars)
docker run --rm \
  -v "${PROJECT}_uploads_data:/uploads:ro" \
  -v "$(cd "$BACKUP_DIR" && pwd):/backup" \
  alpine tar czf "/backup/uploads-$STAMP.tar.gz" -C /uploads .

# 2b. Private files volume (return photos, try-on photos, packing videos), when
#     they are stored locally. Treat this archive as personal data.
if docker volume inspect "${PROJECT}_private_uploads_data" >/dev/null 2>&1; then
  docker run --rm \
    -v "${PROJECT}_private_uploads_data:/private:ro" \
    -v "$(cd "$BACKUP_DIR" && pwd):/backup" \
    alpine tar czf "/backup/private-uploads-$STAMP.tar.gz" -C /private .
fi

# 2c. Private files in Cloudflare R2, once they live there: a mirror on this
#     server, and a dated archive of it, so losing the R2 account loses nothing.
#     Needs rclone and a read-only remote, e.g. R2_BACKUP_REMOTE=r2:clowe-private
#     (DEPLOY_RUNBOOK, "Private files in R2"). Skipped when either is missing.
if [ -n "${R2_BACKUP_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  rclone sync "$R2_BACKUP_REMOTE" "$BACKUP_DIR/r2-private"
  tar czf "$BACKUP_DIR/r2-private-$STAMP.tar.gz" -C "$BACKUP_DIR/r2-private" .
fi

# 3. Prune backups older than KEEP_DAYS
find "$BACKUP_DIR" -name '*.gz' -mtime "+$KEEP_DAYS" -delete

echo "[backup] done: db-$STAMP.sql.gz + uploads-$STAMP.tar.gz + private-uploads-$STAMP.tar.gz (keeping $KEEP_DAYS days)"

# Restore examples:
#   gunzip -c backups/db-XXXX.sql.gz | docker compose -f docker-compose.prod.yml --env-file .env.production exec -T db sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'
#   docker run --rm -v <project>_uploads_data:/uploads -v $(pwd)/backups:/backup alpine tar xzf /backup/uploads-XXXX.tar.gz -C /uploads
#   docker run --rm -v <project>_private_uploads_data:/private -v $(pwd)/backups:/backup alpine tar xzf /backup/private-uploads-XXXX.tar.gz -C /private
