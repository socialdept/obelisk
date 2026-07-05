#!/usr/bin/env bash
#
# Restore an Obelisk Postgres backup produced by scripts/backup.sh (LAB-55).
#
#   ./scripts/restore.sh backups/obelisk-20260704-030000.dump
#
# Recovery procedure:
#   1. Stop the app so nothing writes mid-restore:  docker compose stop app
#   2. ./scripts/restore.sh <dump>                  (this script; --clean drops first)
#   3. docker compose start app                     (migrate-on-boot is a no-op)
#
# pg_restore replays the schema (including CREATE EXTENSION vector) and data.
# HNSW / GIN indexes rebuild during restore — on a large archive this can take
# a while; that's expected. Set FORCE=1 to skip the confirmation prompt.
#
set -euo pipefail

DUMP="${1:-}"
DB_NAME="${POSTGRES_DB:-obelisk}"
DB_USER="${POSTGRES_USER:-obelisk}"

if [ -z "$DUMP" ]; then
  echo "usage: $0 <path-to-dump>" >&2
  exit 1
fi
if [ ! -f "$DUMP" ]; then
  echo "no such file: $DUMP" >&2
  exit 1
fi

if [ "${FORCE:-0}" != "1" ]; then
  echo "This will DROP and replace the contents of database '$DB_NAME' from:"
  echo "  $DUMP"
  read -r -p "Continue? [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ] || { echo "aborted"; exit 1; }
fi

echo "restoring '$DB_NAME' from $DUMP …"
# --clean --if-exists drops existing objects first so this is a full replace;
# --no-owner keeps it portable across roles.
docker compose exec -T postgres pg_restore -U "$DB_USER" -d "$DB_NAME" \
  --clean --if-exists --no-owner < "$DUMP"

echo "restore complete. Row counts:"
docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT 'records' AS table, count(*) FROM records
   UNION ALL SELECT 'record_embeddings', count(*) FROM record_embeddings
   UNION ALL SELECT 'record_links', count(*) FROM record_links
   UNION ALL SELECT 'events', count(*) FROM events;"
