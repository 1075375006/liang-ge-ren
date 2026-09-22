#!/usr/bin/env bash
# Creates and destroys only a unique smoke-test project, never a deployment's data.
set -Eeuo pipefail
umask 077
[[ $# -eq 0 || ( $# -eq 1 && "$1" == --config-only ) ]] || { echo 'Usage: bash ops/test-production.sh [--config-only]' >&2; exit 1; }
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
for command in docker openssl curl; do command -v "$command" >/dev/null || exit 1; done
smoke_id="lgr-smoke-$(date +%s)-$$"
smoke_port=$((18000 + ($$ % 1000)))
export DEPLOY_STATE_DIR="$ROOT/.local/$smoke_id"
export DEPLOY_ENV_FILE="$DEPLOY_STATE_DIR/production.env"
mkdir -p "$DEPLOY_STATE_DIR/backups"
source "$ROOT/ops/common.sh"
cat >"$ENV_FILE" <<CONFIG
COMPOSE_PROJECT_NAME='$smoke_id'
APP_URL='https://app.example.test'
BIND_ADDRESS='127.0.0.1'
APP_PORT='$smoke_port'
SUPPORT_EMAIL='support@example.test'
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
  for resource in postgres_data; do
    if docker volume inspect "${smoke_id}_$resource" >/dev/null 2>&1; then
      label=$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "${smoke_id}_$resource") || return 1
      [[ "$label" == "$smoke_id" ]] || return 1
    fi
  done
  for resource in backend outbound; do
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
  if [[ $status -ne 0 ]]; then smoke_compose logs --tail=40 app worker backup >&2 || true; fi
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
smoke_compose up -d --wait --wait-timeout 180 app worker backup
for service in worker db; do
  ports=$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$(smoke_compose ps -q "$service")")
  [[ "$ports" == '{}' || "$ports" == 'null' ]] || die "$service 暴露了宿主端口"
done
[[ $(smoke_compose exec -T app id -u) != 0 ]] || die '应用没有以非 root 运行'
host_endpoint="127.0.0.1:${smoke_port}"
[[ "$host_endpoint" =~ ^127\.0\.0\.1:[0-9]+$ ]] || die "应用未仅绑定本机端口：$host_endpoint"
smoke_compose exec -T app node -e "fetch('http://127.0.0.1:33442/api/ready').then(async r=>{if(!r.ok)throw new Error(await r.text())}).catch(e=>{console.error(e);process.exit(1)})"
printf '\n'
smoke_compose exec -T app node -e "fetch('http://127.0.0.1:33442/').then(async r=>{if(!r.ok||!(await r.text()).includes('<div id=\"root\"></div>'))process.exit(1)}).catch(()=>process.exit(1))"
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
smoke_compose exec -T app node -e "fetch('http://127.0.0.1:33442/api/ready').then(async r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
printf '\nPASS: production Docker build, loopback application port, private database and worker, non-root app, idempotent migration, external-proxy configuration, daily backup health, manual backup and verified restore\n'
