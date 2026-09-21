#!/usr/bin/env bash
# Creates and destroys only a unique smoke-test project, never a deployment's data.
set -Eeuo pipefail
umask 077
[[ $# -eq 0 || ( $# -eq 1 && "$1" == --config-only ) ]] || { echo 'Usage: bash ops/test-production.sh [--config-only]' >&2; exit 1; }
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
for command in docker openssl curl; do command -v "$command" >/dev/null || exit 1; done
smoke_id="lgr-smoke-$(date +%s)-$$"
export DEPLOY_STATE_DIR="$ROOT/.local/$smoke_id"
mkdir -p "$DEPLOY_STATE_DIR/backups"
source "$ROOT/ops/common.sh"
cat >"$ENV_FILE" <<CONFIG
COMPOSE_PROJECT_NAME='$smoke_id'
DOMAIN='localhost'
SUPPORT_EMAIL='support@example.test'
ACME_EMAIL='support@example.test'
POSTGRES_USER='couple'
POSTGRES_DB='couple'
POSTGRES_PASSWORD='$(openssl rand -hex 32)'
APP_IMAGE='liang-ge-ren:production-smoke'
APP_VERSION='production-smoke'
REQUIRE_VERIFIED_EMAIL='true'
SMTP_HOST='mailpit'
SMTP_PORT='1025'
SMTP_SECURE='false'
SMTP_REQUIRE_TLS='false'
SMTP_FROM='smoke@example.test'
BACKUP_DIR='$DEPLOY_STATE_DIR/backups'
BACKUP_UID='$(id -u)'
BACKUP_GID='$(id -g)'
HTTP_PORT='127.0.0.1:0'
HTTPS_PORT='127.0.0.1:0'
CONFIG
write_value SMTP_PASS "smoke\\literal\$dollar'quote" >>"$ENV_FILE"
cat >"$STATE_DIR/mailpit.yaml" <<'MAILPIT'
services:
  mailpit:
    image: public.ecr.aws/supabase/mailpit:v1.30.2
    networks: [backend]
    logging:
      driver: json-file
      options:
        max-size: 1m
        max-file: '1'
MAILPIT
smoke_compose() (
  clear_compose_overrides
  docker compose --project-name "$smoke_id" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$STATE_DIR/mailpit.yaml" "$@"
)
owned_smoke_resources() {
  local resource label ids
  [[ "$smoke_id" =~ ^lgr-smoke-[0-9]+-[0-9]+$ ]] || return 1
  ids=$(smoke_compose ps -aq) || return 1
  for resource in $ids; do
    label=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$resource") || return 1
    [[ "$label" == "$smoke_id" ]] || return 1
  done
  for resource in postgres_data caddy_data caddy_config; do
    if docker volume inspect "${smoke_id}_$resource" >/dev/null 2>&1; then
      label=$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "${smoke_id}_$resource") || return 1
      [[ "$label" == "$smoke_id" ]] || return 1
    fi
  done
  for resource in backend edge outbound; do
    if docker network inspect "${smoke_id}_$resource" >/dev/null 2>&1; then
      label=$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}' "${smoke_id}_$resource") || return 1
      [[ "$label" == "$smoke_id" ]] || return 1
    fi
  done
}
# This path resolves configuration only. It never starts or deletes any Docker resource.
if [[ ${1:-} == --config-only ]]; then
  smoke_compose config --format json >"$STATE_DIR/resolved-compose.json"
  printf '%s\n' "$STATE_DIR/resolved-compose.json"
  exit 0
fi
cleanup() {
  status=$?
  trap - EXIT
  if [[ $status -ne 0 ]]; then smoke_compose logs --tail=40 app worker caddy backup >&2 || true; fi
  if owned_smoke_resources; then
    smoke_compose down -v --remove-orphans >/dev/null 2>&1 || true
  else
    echo 'Smoke cleanup skipped: resource ownership could not be verified.' >&2
  fi
  echo "Smoke artifacts retained: $STATE_DIR" >&2
  exit "$status"
}
trap cleanup EXIT
smoke_compose config --quiet
if [[ ${SKIP_SMOKE_BUILD:-false} != true ]]; then
  docker build --build-arg VCS_REF=production-smoke -t liang-ge-ren:production-smoke "$ROOT"
fi
smoke_compose up -d --wait --wait-timeout 120 db mailpit
smoke_compose run --rm --no-deps migrate
smoke_compose run --rm --no-deps migrate
smoke_compose up -d --wait --wait-timeout 180 app worker backup caddy
for service in app worker db; do
  ports=$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$(smoke_compose ps -q "$service")")
  [[ "$ports" == '{}' || "$ports" == 'null' ]] || die "$service 暴露了宿主端口"
done
[[ $(smoke_compose exec -T app id -u) != 0 ]] || die '应用没有以非 root 运行'
for attempt in {1..30}; do
  if smoke_compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$STATE_DIR/root.crt" >/dev/null 2>&1; then break; fi
  sleep 1
done
port=$(smoke_compose port caddy 443); port=${port##*:}
curl --fail --silent --show-error --cacert "$STATE_DIR/root.crt" "https://localhost:$port/api/ready"
printf '\n'
smoke_compose exec -T app node --input-type=module <"$ROOT/ops/smoke-api.mjs"
smoke_compose exec -T app node --input-type=module <"$ROOT/ops/check-smtp.mjs"
backup_path=$(bash "$ROOT/scripts/backup.sh")
# Mutation after backup verifies that restore really replaces current data.
smoke_compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
CREATE TABLE restore_smoke_sentinel (value text);
INSERT INTO restore_smoke_sentinel VALUES ('must disappear after restore');
SQL
bash "$ROOT/scripts/restore.sh" "$backup_path" --confirm-replace-database
counts=$(smoke_compose exec -T db sh -c 'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM spaces),to_regclass('\''public.restore_smoke_sentinel'\'') IS NULL"')
[[ "$counts" == '2|1|t' ]] || die "恢复数据不符合预期：$counts"
smoke_compose exec -T app node dist/scripts/check-ledger.js
port=$(smoke_compose port caddy 443); port=${port##*:}
curl --fail --silent --show-error --cacert "$STATE_DIR/root.crt" "https://localhost:$port/api/ready"
printf '\nPASS: production Docker build, private ports, non-root app, idempotent migration, local HTTPS, daily backup health, manual backup and verified restore\n'
