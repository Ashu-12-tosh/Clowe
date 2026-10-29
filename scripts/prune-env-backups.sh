#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Retention for the server's .env.production backups (.env.production.bak-*):
# keep the 5 newest, root-only (chmod 600), and delete the rest. "Newest" is
# the date in the name (bak-YYYYMMDD[-HHMMSS]-what), not the file's mtime:
# backups are made with cp -p, which keeps the source's mtime.
#
#   ./scripts/prune-env-backups.sh           list what would be deleted (names only)
#   ./scripts/prune-env-backups.sh --apply   delete it
#
# Run from the repo root on the server, after making a new backup. Never
# prints a file's contents.
# ---------------------------------------------------------------------------
set -euo pipefail
KEEP=5
cd "$(dirname "$0")/.."

# "<YYYYMMDDHHMMSS> <name>", newest first; a name without a time counts as 00:00:00.
sorted=$(for f in .env.production.bak-*; do
  [ -f "$f" ] || continue
  stamp=$(printf '%s' "$f" | sed -nE 's/^\.env\.production\.bak-([0-9]{8})(-([0-9]{6}))?.*/\1\3/p')
  [ -n "$stamp" ] || { echo "skipped (no date in the name): $f" >&2; continue; }
  printf '%-14s %s\n' "$(printf '%s000000' "$stamp" | cut -c1-14)" "$f"
done | sort -r)

keep=$(printf '%s\n' "$sorted" | sed -n "1,${KEEP}p" | awk '{print $2}')
drop=$(printf '%s\n' "$sorted" | sed -n "$((KEEP + 1)),\$p" | awk '{print $2}')

for f in $keep; do chmod 600 "$f" && chown root:root "$f"; done
echo "keeping (${KEEP} newest, chmod 600, root only):"
printf '  %s\n' $keep
if [ -z "$drop" ]; then
  echo "nothing to delete"
  exit 0
fi
echo "older, to delete:"
printf '  %s\n' $drop
if [ "${1:-}" = "--apply" ]; then
  for f in $drop; do rm -f -- "$f"; done
  echo "deleted $(printf '%s\n' $drop | wc -l) file(s)"
else
  echo "(dry run: nothing deleted; run with --apply to delete)"
fi
