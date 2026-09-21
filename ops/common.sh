#!/usr/bin/env bash
# Sourced by operational scripts. Never source the deployment env as shell code.
set -Eeuo pipefail
umask 077
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STATE_DIR=${DEPLOY_STATE_DIR:-"$ROOT/.local/production"}
case "$STATE_DIR" in /*) ;; *) echo 'DEPLOY_STATE_DIR must be an absolute path' >&2; exit 1;; esac
ENV_FILE="$STATE_DIR/production.env"
COMPOSE_FILE="$ROOT/ops/compose.production.yaml"

die() { echo "错误：$*" >&2; exit 1; }
info() { echo "[两个人] $*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少 $1"; }
clear_compose_overrides() {
  local key
  # Clear every production interpolation, including fields omitted from a test env.
  for key in COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES COMPOSE_PROFILES APP_IMAGE APP_VERSION POSTGRES_IMAGE POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB DOMAIN ACME_EMAIL HTTP_PORT HTTPS_PORT LOG_LEVEL REGISTRATION_OPEN REQUIRE_VERIFIED_EMAIL SUPPORT_EMAIL OPERATOR_NAME WECHAT_LOGIN_ENABLED BEICHEN_APP_ID BEICHEN_APP_KEY SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_REQUIRE_TLS SMTP_USER SMTP_PASS SMTP_FROM BACKUP_DIR BACKUP_UID BACKUP_GID BACKUP_RETENTION_DAYS; do
    unset "$key"
  done
  while IFS='=' read -r key _; do
    if [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]]; then unset "$key"; fi
  done <"$ENV_FILE"
}
compose() (
  clear_compose_overrides
  local project
  project=$(config_value COMPOSE_PROJECT_NAME)
  docker compose --project-name "${project:-liang-ge-ren-production}" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
)
require_state() { [[ -s "$ENV_FILE" ]] || die "生产配置不存在，请先运行 scripts/deploy.sh"; }
config_value() {
  local key=$1 line value
  [[ -f "$ENV_FILE" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$key="* ]] || continue
    value=${line#*=}
    if [[ "$value" == "'"*"'" ]]; then
      value=${value:1:${#value}-2}
      value=${value//\\\'/\'}
    elif [[ "$value" == \"*\" ]]; then
      value=${value:1:${#value}-2}
      value=${value//\\\"/\"}
      value=${value//\\\\/\\}
      value=${value//\$\$/\$}
    fi
    printf '%s' "$value"
    return 0
  done <"$ENV_FILE"
}
write_value() {
  local value=$2
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$1 不能包含换行"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\$/\$\$}
  printf '%s="%s"\n' "$1" "$value"
}
set_config() {
  local key=$1 value=$2 temp="$ENV_FILE.tmp.$$" line
  : >"$temp"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$key="* ]] || printf '%s\n' "$line" >>"$temp"
  done <"$ENV_FILE"
  write_value "$key" "$value" >>"$temp"
  chmod 600 "$temp"
  mv "$temp" "$ENV_FILE"
}
acquire_lock() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  if ! mkdir "$STATE_DIR/operation.lock" 2>/dev/null; then
    die "另一个部署/备份/恢复操作持有 $STATE_DIR/operation.lock；确认无操作运行后才能手动删除该空锁目录"
  fi
  trap 'rmdir "$STATE_DIR/operation.lock" 2>/dev/null || true' EXIT
}
digest_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi
}
ensure_database() {
  local existing image_ref pinned
  existing=$(compose ps -aq db)
  if [[ -n "$existing" ]]; then
    # Resolve the image actually used by this database, never the current rolling tag.
    image_ref=$(docker inspect --format '{{.Image}}' "$existing")
  else
    image_ref=$(config_value POSTGRES_IMAGE)
    image_ref=${image_ref:-postgres:17-bookworm}
    compose pull db
  fi
  pinned=$(docker image inspect --format '{{index .RepoDigests 0}}' "$image_ref")
  [[ "$pinned" =~ ^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$ ]] || die '无法取得当前 PostgreSQL 镜像摘要；未重建数据库。请在维护窗口核查镜像来源。'
  set_config POSTGRES_IMAGE "$pinned"
  # Existing databases are not recreated during application releases or restores.
  compose up -d --no-recreate --pull never --wait --wait-timeout 120 db
}
backup_database() {
  local reason=${1:-manual} dir path name temp
  dir=$(config_value BACKUP_DIR)
  [[ -n "$dir" && "$dir" == /* ]] || die 'BACKUP_DIR 必须为绝对路径'
  mkdir -p "$dir"
  chmod 700 "$dir"
  name="$reason-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
  path="$dir/$name"
  temp="$path.partial"
  info "备份数据库：$path"
  if ! compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' >"$temp"; then
    rm -f "$temp"
    die '备份失败；没有进行后续数据库操作'
  fi
  if ! compose exec -T db pg_restore --list <"$temp" >/dev/null; then
    rm -f "$temp"
    die '备份完整性检查失败；没有进行后续数据库操作'
  fi
  mv "$temp" "$path"
  (cd "$dir" && digest_file "$name" >"$name.sha256")
  printf '%s' "$path"
}
