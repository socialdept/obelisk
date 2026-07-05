#!/usr/bin/env bash
#
# Back up the Obelisk Postgres database (LAB-55). Writes a timestamped,
# compressed custom-format dump (pg_dump -Fc) that scripts/restore.sh can load,
# then prunes to the most recent BACKUP_KEEP dumps.
#
# The Postgres volume is Obelisk's only source of truth — records, embeddings,
# links, events, tokens, audiences, webhooks, blocklists. Tab's sqlite state is
# regenerable (it re-syncs from the network) and does NOT need backing up.
#
#   ./scripts/backup.sh
#   BACKUP_DIR=/mnt/backups BACKUP_KEEP=30 ./scripts/backup.sh
#
# Schedule it from cron on the host, e.g.:
#   0 3 * * *  cd /srv/obelisk && ./scripts/backup.sh >> /var/log/obelisk-backup.log 2>&1
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
DB_NAME="${POSTGRES_DB:-obelisk}"
DB_USER="${POSTGRES_USER:-obelisk}"

mkdir -p "$BACKUP_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/obelisk-$stamp.dump"

echo "backing up database '$DB_NAME' → $out"
# -Fc = custom format (compressed, parallel-restorable). -T to disable the TTY.
docker compose exec -T postgres pg_dump -U "$DB_USER" -Fc "$DB_NAME" > "$out"

size="$(du -h "$out" | cut -f1)"
echo "wrote $out ($size)"

# Retention: keep the newest BACKUP_KEEP dumps, delete the rest. Portable to
# bash 3.2 (macOS) — no mapfile.
ls -1t "$BACKUP_DIR"/obelisk-*.dump 2>/dev/null | tail -n "+$((BACKUP_KEEP + 1))" | while read -r f; do
  echo "pruning old backup $f"
  rm -f "$f"
done
