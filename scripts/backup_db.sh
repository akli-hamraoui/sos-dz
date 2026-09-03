#!/usr/bin/env bash
# Database backup for SOS DZ -- dumps the live database (SQLite, MySQL, or
# PostgreSQL, whichever DB_ENGINE in .env is currently set to), compresses
# it, and stores it timestamped in a directory OUTSIDE the git repo. Meant
# to be run on a schedule (see DEPLOYMENT.md "Database backups" -- a
# systemd timer every 2h is the documented setup), but safe to run by hand
# too: `./scripts/backup_db.sh`.
#
# This backs up to local VPS disk only. It protects against a bad
# migration, an accidental deletion, or app-level data corruption -- it
# does NOT protect against losing the VPS itself (disk failure, account
# loss, provider incident). See DEPLOYMENT.md for the recommended
# off-site copy (rclone to S3/R2) once this is confirmed working.
#
# Never put credentials on the command line (visible to any other user via
# `ps`) -- DB_PASSWORD is passed to mysqldump/pg_dump via MYSQL_PWD/
# PGPASSWORD env vars instead, both of which those tools read directly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${SOS_DZ_ENV_FILE:-$REPO_ROOT/.env}"

# Where backups are stored -- deliberately outside the repo (a `git pull`
# or `git clean` must never be able to touch these) and outside anything
# Nginx serves, so a backup is never reachable over HTTP. Override with
# SOS_DZ_BACKUP_DIR for local testing (a real VPS deploy should leave this
# at the default, which needs one-time `sudo mkdir` + ownership setup --
# see DEPLOYMENT.md).
BACKUP_DIR="${SOS_DZ_BACKUP_DIR:-/var/backups/sos-dz}"
RETENTION_DAYS="${SOS_DZ_BACKUP_RETENTION_DAYS:-14}"
LOG_FILE="$BACKUP_DIR/backup.log"

log() {
  # Every run leaves a trace either way (success or failure) -- silent
  # failure is exactly what makes a backup system untrustworthy.
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $1" | tee -a "$LOG_FILE" >&2
}

fail() {
  log "ERROR: $1"
  exit 1
}

mkdir -p "$BACKUP_DIR"
# 700/600: this may contain personal data (names, phone numbers) same as
# the live DB does -- never world- or group-readable.
chmod 700 "$BACKUP_DIR"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"

[ -f "$ENV_FILE" ] || fail "env file not found at $ENV_FILE (set SOS_DZ_ENV_FILE to override)"

# Load DB_* from .env without exporting everything else in it (SECRET_KEY,
# API keys, etc.) into this script's environment.
DB_ENGINE=$(grep -E '^DB_ENGINE=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
DB_NAME=$(grep -E '^DB_NAME=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
DB_USER=$(grep -E '^DB_USER=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
DB_PASSWORD=$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
DB_HOST=$(grep -E '^DB_HOST=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
DB_PORT=$(grep -E '^DB_PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)
DB_ENGINE="${DB_ENGINE:-sqlite3}"

TIMESTAMP=$(date -u '+%Y%m%d-%H%M%S')
TMP_FILE=$(mktemp "$BACKUP_DIR/.tmp-XXXXXX")
trap 'rm -f "$TMP_FILE"' EXIT  # never leave a half-written temp file behind, success or failure

case "$DB_ENGINE" in
  sqlite3)
    # Same default as Django's own settings.py (DATABASES["default"]["NAME"]
    # falls back to REPO_ROOT/db.sqlite3 when DB_NAME is blank) -- kept in
    # sync deliberately so this script backs up the exact file the app is
    # actually using without needing its own separate config.
    DB_PATH="${DB_NAME:-$REPO_ROOT/db.sqlite3}"
    [ -f "$DB_PATH" ] || fail "sqlite database not found at $DB_PATH"
    command -v sqlite3 >/dev/null || fail "sqlite3 CLI not installed"
    # `.backup` uses SQLite's own online backup API -- safe to run against
    # a live database with the app still serving requests, unlike a plain
    # `cp` which could copy a page mid-write. Output stays uncompressed on
    # disk only inside TMP_FILE, then gzipped straight into the final name.
    sqlite3 "$DB_PATH" ".backup '$TMP_FILE'" || fail "sqlite3 .backup failed"
    OUT_FILE="$BACKUP_DIR/sos-dz-db-$TIMESTAMP.sqlite3.gz"
    gzip -c "$TMP_FILE" > "$OUT_FILE.part" || fail "gzip failed"
    ;;
  mysql)
    [ -n "$DB_NAME" ] && [ -n "$DB_USER" ] && [ -n "$DB_HOST" ] || fail "DB_NAME/DB_USER/DB_HOST must be set in $ENV_FILE for DB_ENGINE=mysql"
    command -v mysqldump >/dev/null || fail "mysqldump not installed"
    OUT_FILE="$BACKUP_DIR/sos-dz-db-$TIMESTAMP.sql.gz"
    MYSQL_PWD="$DB_PASSWORD" mysqldump \
      --single-transaction --quick --routines --triggers \
      -h "$DB_HOST" ${DB_PORT:+-P "$DB_PORT"} -u "$DB_USER" "$DB_NAME" \
      | gzip -c > "$OUT_FILE.part" || fail "mysqldump failed"
    ;;
  postgresql)
    [ -n "$DB_NAME" ] && [ -n "$DB_USER" ] && [ -n "$DB_HOST" ] || fail "DB_NAME/DB_USER/DB_HOST must be set in $ENV_FILE for DB_ENGINE=postgresql"
    command -v pg_dump >/dev/null || fail "pg_dump not installed"
    OUT_FILE="$BACKUP_DIR/sos-dz-db-$TIMESTAMP.sql.gz"
    PGPASSWORD="$DB_PASSWORD" pg_dump \
      -h "$DB_HOST" ${DB_PORT:+-p "$DB_PORT"} -U "$DB_USER" -d "$DB_NAME" --no-owner \
      | gzip -c > "$OUT_FILE.part" || fail "pg_dump failed"
    ;;
  *)
    fail "unknown DB_ENGINE '$DB_ENGINE' (expected sqlite3, mysql, or postgresql)"
    ;;
esac

# Atomic rename -- a reader (or the retention cleanup below) never sees a
# partially-written backup file, only a finished one appearing all at once.
mv "$OUT_FILE.part" "$OUT_FILE"
chmod 600 "$OUT_FILE"
SIZE=$(du -h "$OUT_FILE" | cut -f1)
log "OK: backed up ($DB_ENGINE) to $OUT_FILE ($SIZE)"

# Retention: delete backups older than N days, but only after this run's
# own backup has already succeeded and landed on disk -- never prune first.
DELETED=$(find "$BACKUP_DIR" -maxdepth 1 -name 'sos-dz-db-*.gz' -mtime "+$RETENTION_DAYS" -print -delete | wc -l)
[ "$DELETED" -gt 0 ] && log "Removed $DELETED backup(s) older than $RETENTION_DAYS days"

exit 0
