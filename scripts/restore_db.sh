#!/usr/bin/env bash
# Restores a SOS DZ database backup produced by backup_db.sh. Destructive
# by nature (it overwrites the live database) -- always asks for explicit
# confirmation unless run with --yes, and for SQLite it also saves a
# safety copy of whatever's live right before overwriting it, so a wrong
# restore target isn't unrecoverable either.
#
# Usage:
#   ./scripts/restore_db.sh                 # restores the most recent backup
#   ./scripts/restore_db.sh /path/to/backup.gz
#   ./scripts/restore_db.sh --yes            # skip the confirmation prompt
#
# Stop the app (gunicorn) before running this against a live production
# database -- see DEPLOYMENT.md "Database backups" -- so nothing writes to
# the database mid-restore.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${SOS_DZ_ENV_FILE:-$REPO_ROOT/.env}"
BACKUP_DIR="${SOS_DZ_BACKUP_DIR:-/var/backups/sos-dz}"

ASSUME_YES=false
BACKUP_FILE=""
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=true ;;
    *) BACKUP_FILE="$arg" ;;
  esac
done

fail() { echo "ERROR: $1" >&2; exit 1; }

if [ -z "$BACKUP_FILE" ]; then
  BACKUP_FILE=$(find "$BACKUP_DIR" -maxdepth 1 -name 'sos-dz-db-*.gz' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)
  [ -n "$BACKUP_FILE" ] || fail "no backup file given and none found in $BACKUP_DIR"
  echo "No backup file given -- using the most recent one: $BACKUP_FILE"
fi
[ -f "$BACKUP_FILE" ] || fail "backup file not found: $BACKUP_FILE"

[ -f "$ENV_FILE" ] || fail "env file not found at $ENV_FILE (set SOS_DZ_ENV_FILE to override)"
DB_ENGINE=$(grep -E '^DB_ENGINE=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
DB_NAME=$(grep -E '^DB_NAME=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
DB_USER=$(grep -E '^DB_USER=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
DB_PASSWORD=$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
DB_HOST=$(grep -E '^DB_HOST=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
DB_PORT=$(grep -E '^DB_PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
DB_ENGINE="${DB_ENGINE:-sqlite3}"

echo "About to restore '$BACKUP_FILE' into the $DB_ENGINE database configured in $ENV_FILE."
echo "THIS OVERWRITES THE CURRENT DATABASE. Make sure the app (gunicorn) is stopped first."
if [ "$ASSUME_YES" != true ]; then
  read -r -p "Type 'restore' to continue: " CONFIRM
  [ "$CONFIRM" = "restore" ] || fail "aborted (confirmation not given)"
fi

case "$DB_ENGINE" in
  sqlite3)
    DB_PATH="${DB_NAME:-$REPO_ROOT/db.sqlite3}"
    command -v sqlite3 >/dev/null || fail "sqlite3 CLI not installed"
    if [ -f "$DB_PATH" ]; then
      SAFETY="$DB_PATH.before-restore-$(date -u '+%Y%m%d-%H%M%S')"
      cp "$DB_PATH" "$SAFETY"
      echo "Saved a safety copy of the current database to $SAFETY"
    fi
    TMP=$(mktemp)
    trap 'rm -f "$TMP"' EXIT
    gunzip -c "$BACKUP_FILE" > "$TMP" || fail "failed to decompress $BACKUP_FILE"
    # Basic sanity check before clobbering the live file -- a truncated or
    # non-SQLite backup fails loudly here instead of leaving a corrupt DB.
    sqlite3 "$TMP" "PRAGMA integrity_check;" | grep -q '^ok$' || fail "backup file failed SQLite integrity check, aborting -- current database left untouched"
    mv "$TMP" "$DB_PATH"
    trap - EXIT
    echo "OK: restored $DB_PATH from $BACKUP_FILE"
    ;;
  mysql)
    [ -n "$DB_NAME" ] && [ -n "$DB_USER" ] && [ -n "$DB_HOST" ] || fail "DB_NAME/DB_USER/DB_HOST must be set in $ENV_FILE"
    command -v mysql >/dev/null || fail "mysql CLI not installed"
    gunzip -c "$BACKUP_FILE" | MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_HOST" ${DB_PORT:+-P "$DB_PORT"} -u "$DB_USER" "$DB_NAME" \
      || fail "mysql restore failed"
    echo "OK: restored $DB_NAME@$DB_HOST from $BACKUP_FILE"
    ;;
  postgresql)
    [ -n "$DB_NAME" ] && [ -n "$DB_USER" ] && [ -n "$DB_HOST" ] || fail "DB_NAME/DB_USER/DB_HOST must be set in $ENV_FILE"
    command -v psql >/dev/null || fail "psql CLI not installed"
    gunzip -c "$BACKUP_FILE" | PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" ${DB_PORT:+-p "$DB_PORT"} -U "$DB_USER" -d "$DB_NAME" \
      || fail "psql restore failed"
    echo "OK: restored $DB_NAME@$DB_HOST from $BACKUP_FILE"
    ;;
  *)
    fail "unknown DB_ENGINE '$DB_ENGINE' (expected sqlite3, mysql, or postgresql)"
    ;;
esac

echo "Restore complete. Restart the app: sudo systemctl restart sos-dz-gunicorn"
