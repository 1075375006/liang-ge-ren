#!/bin/sh
set -eu
umask 077
retention=${BACKUP_RETENTION_DAYS:-14}
case "$retention" in ''|*[!0-9]*) echo 'BACKUP_RETENTION_DAYS must be a positive integer' >&2; exit 1;; esac
[ "$retention" -ge 1 ] || exit 1
mkdir -p /backups
while :; do
  name="auto-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
  partial="/backups/$name.partial"
  if pg_dump --format=custom --no-owner --file="$partial" && pg_restore --list "$partial" >/dev/null; then
    mv "$partial" "/backups/$name"
    (cd /backups && sha256sum "$name" >"$name.sha256")
    date +%s >/backups/.last-success
    # Delete only this service's dated backups, after a new backup succeeded.
    find /backups -maxdepth 1 -type f -name 'auto-*.dump*' -mtime "+$retention" -delete
    echo "$(date -u +%FT%TZ) backup complete: $name"
    sleep 86400 & wait "$!"
  else
    rm -f "$partial"
    echo "$(date -u +%FT%TZ) backup failed; retrying in 5 minutes" >&2
    sleep 300 & wait "$!"
  fi
done
