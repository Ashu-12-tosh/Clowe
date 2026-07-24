#!/bin/sh
# Clowe — nightly Postgres + uploads backup.
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

# 2. Uploaded images volume
docker run --rm \
  -v "$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')_uploads_data:/uploads:ro" \
  -v "$(cd "$BACKUP_DIR" && pwd):/backup" \
  alpine tar czf "/backup/uploads-$STAMP.tar.gz" -C /uploads .

# 3. Prune backups older than KEEP_DAYS
find "$BACKUP_DIR" -name '*.gz' -mtime "+$KEEP_DAYS" -delete

echo "[backup] done: db-$STAMP.sql.gz + uploads-$STAMP.tar.gz (keeping $KEEP_DAYS days)"

# Restore examples:
#   gunzip -c backups/db-XXXX.sql.gz | docker compose -f docker-compose.prod.yml --env-file .env.production exec -T db sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'
#   docker run --rm -v <project>_uploads_data:/uploads -v $(pwd)/backups:/backup alpine tar xzf /backup/uploads-XXXX.tar.gz -C /uploads
