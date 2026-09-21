#!/usr/bin/env bash
# Non-interactive production deployment; existing secrets and data are preserved.
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/ops/common.sh"

if [[ ${1:-} == '--help' ]]; then
  cat <<'HELP'
首次部署：DOMAIN=app.example.com SUPPORT_EMAIL=help@example.com SMTP_HOST=smtp.example.com SMTP_FROM=hello@example.com bash scripts/deploy.sh
可选：SMTP_USER、SMTP_PASS、SMTP_PORT、SMTP_SECURE、ACME_EMAIL、OPERATOR_NAME。
以后部署：bash scripts/deploy.sh（使用持久化配置，不覆盖已有密钥）。
配置目录：DEPLOY_STATE_DIR，默认项目的 .local/production。
必须提前把域名解析到当前服务器并放通 80/443；Docker Compose v2+、Git、OpenSSL、curl 可用。
HELP
  exit 0
fi
[[ $# -eq 0 ]] || die '只支持 --help；通过环境变量提供首次配置'
for command in docker git openssl curl; do need "$command"; done
docker info >/dev/null 2>&1 || die 'Docker 服务不可用，请先启动 Docker 或使用 ops/install.sh 安装'
docker compose version >/dev/null 2>&1 || die '需要 Docker Compose v2 或更新版本'

validate_config() {
  local domain=$1 support=$2 smtp=$3 from=$4 password=$5
  [[ "$domain" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]] || die 'DOMAIN 必须是实际公网域名，不带协议、路径或端口'
  [[ "$support" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die '必须配置有效 SUPPORT_EMAIL，作为用户支持与隐私联系地址'
  [[ -n "$smtp" && -n "$from" ]] || die '公开运营必须提供 SMTP_HOST 和 SMTP_FROM，用于注册验证和找回密码'
  [[ "$password" =~ ^[a-zA-Z0-9]{32,}$ ]] || die '生产数据库密码必须至少 32 位随机字母数字'
}

if [[ -s "$ENV_FILE" ]]; then
  validate_config "$(config_value DOMAIN)" "$(config_value SUPPORT_EMAIL)" "$(config_value SMTP_HOST)" "$(config_value SMTP_FROM)" "$(config_value POSTGRES_PASSWORD)"
  info "保留现有配置：${ENV_FILE}（本次 shell 的配置变量不会覆盖已有值）"
else
  initial_project=${COMPOSE_PROJECT_NAME:-liang-ge-ren-production}
  [[ "$initial_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die 'COMPOSE_PROJECT_NAME 只能包含小写字母、数字、下划线和连字符'
  if docker volume inspect "${initial_project}_postgres_data" >/dev/null 2>&1; then
    die '检测到已有生产数据库卷但没有生产配置。请找回原 production.env；不会生成新密码或接管已有数据库。'
  fi
  generated_password=$(openssl rand -hex 32)
  validate_config "${DOMAIN:-}" "${SUPPORT_EMAIL:-}" "${SMTP_HOST:-}" "${SMTP_FROM:-}" "$generated_password"
fi
acquire_lock
mkdir -p "$STATE_DIR/backups"
chmod 700 "$STATE_DIR/backups"
if [[ ! -s "$ENV_FILE" ]]; then
  temporary="$ENV_FILE.tmp.$$"
  {
    printf '# Created by scripts/deploy.sh. Keep this file private. Edit only while deployment is idle.\n'
    write_value COMPOSE_PROJECT_NAME "${COMPOSE_PROJECT_NAME:-liang-ge-ren-production}"
    write_value DOMAIN "$DOMAIN"
    write_value SUPPORT_EMAIL "$SUPPORT_EMAIL"
    write_value ACME_EMAIL "${ACME_EMAIL:-$SUPPORT_EMAIL}"
    write_value OPERATOR_NAME "${OPERATOR_NAME:-}"
    write_value POSTGRES_USER couple
    write_value POSTGRES_DB couple
    write_value POSTGRES_PASSWORD "$generated_password"
    write_value APP_IMAGE liang-ge-ren:pending
    write_value APP_VERSION pending
    write_value REQUIRE_VERIFIED_EMAIL true
    write_value REGISTRATION_OPEN true
    write_value BACKUP_DIR "$STATE_DIR/backups"
    write_value BACKUP_UID "$(id -u)"
    write_value BACKUP_GID "$(id -g)"
    write_value BACKUP_RETENTION_DAYS 14
    for key in SMTP_HOST SMTP_FROM SMTP_USER SMTP_PASS; do write_value "$key" "${!key:-}"; done
    write_value SMTP_PORT "${SMTP_PORT:-587}"
    write_value SMTP_SECURE "${SMTP_SECURE:-false}"
    write_value SMTP_REQUIRE_TLS "${SMTP_REQUIRE_TLS:-true}"
    for key in WECHAT_LOGIN_ENABLED BEICHEN_APP_ID BEICHEN_APP_KEY; do write_value "$key" "${!key:-}"; done
  } >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$ENV_FILE"
  unset generated_password
  info "首次生产配置已安全保存：$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
# A caller's stale environment must not silently override persisted configuration.
while IFS='=' read -r key _; do
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] && unset "$key"
done <"$ENV_FILE"
compose config --quiet

revision=$(git -C "$ROOT" rev-parse HEAD)
version=$revision
if [[ -n $(git -C "$ROOT" status --porcelain --untracked-files=normal) ]]; then
  version="$revision-dirty-$(date -u +%Y%m%d%H%M%S)"
  info '工作区有未提交内容；镜像将标记 dirty，生产更新推荐先提交代码。'
fi
# Unique tags preserve the previous image even when rebuilding the same Git commit.
candidate="liang-ge-ren:$version-$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 4)"
info "构建版本 ${version}（构建失败不会中断已有应用）"
docker build --pull --build-arg "VCS_REF=$version" --build-arg "BUILD_DATE=$(date -u +%FT%TZ)" --tag "$candidate" "$ROOT"
compose pull caddy
ensure_database
prior_backup='尚未生成；当前数据库未迁移'
cp "$ENV_FILE" "$STATE_DIR/previous.env"
chmod 600 "$STATE_DIR/previous.env"
previous_image=$(config_value APP_IMAGE)
maintenance=false
failure() {
  local exit_code=$?
  trap - ERR
  if [[ "$maintenance" == true ]]; then
    compose stop caddy app worker backup || true
    info '升级失败，应用保持停止，数据库卷、旧镜像和升级前配置均保留；没有自动回退数据库。'
  fi
  info "升级前备份：$prior_backup"
  info "升级前镜像：$previous_image"
  info "升级前配置：$STATE_DIR/previous.env"
  info '排查后可重新部署；需要恢复旧版时按 docs/部署运营.md 的回滚步骤操作。'
  exit "$exit_code"
}
trap failure ERR
maintenance=true
compose stop caddy app worker backup
prior_backup=$(backup_database before-deploy)
set_config APP_IMAGE "$candidate"
set_config APP_VERSION "$version"
compose run --rm --no-deps migrate
compose up -d --no-deps --pull never --wait --wait-timeout 180 app worker backup
compose exec -T app node dist/scripts/check-ledger.js
compose exec -T app node --input-type=module <"$ROOT/ops/check-smtp.mjs"
compose exec -T app node -e "fetch('http://127.0.0.1:33442/api/ready').then(async r=>{if(!r.ok) throw new Error(await r.text());console.log('应用与后台就绪')}).catch(e=>{console.error(e.message);process.exit(1)})"
compose up -d --no-deps caddy
domain=$(config_value DOMAIN)
info "等待 https://$domain 的证书和公网健康检查（最多 3 分钟）"
https_ok=false
deadline=$((SECONDS + 180))
while ((SECONDS < deadline)); do
  if curl --fail --silent --show-error --connect-timeout 3 --max-time 5 "https://$domain/api/ready" >"$STATE_DIR/last-readiness.json" 2>"$STATE_DIR/last-https-error.log" &&
    grep -Eq '"version"[[:space:]]*:[[:space:]]*"'"$version"'"' "$STATE_DIR/last-readiness.json"; then
    https_ok=true
    break
  fi
  sleep 5
done
[[ "$https_ok" == true ]] || { info 'HTTPS 或目标版本检查未通过，请检查 DNS、80/443 防火墙和 Caddy 日志。'; false; }
maintenance=false
cp "$ENV_FILE" "$STATE_DIR/last-success.env"
{
  printf '%s version=%s image=%s previous=%s backup=%s\n' "$(date -u +%FT%TZ)" "$version" "$candidate" "$previous_image" "$prior_backup"
  docker image inspect --format 'image_id={{.Id}}' "$candidate"
  compose images --format json
} >>"$STATE_DIR/releases.log"
info "部署完成：https://$domain"
info '数据库、后台、积分对账及公网 HTTPS 就绪检查通过；真实邮件投递仍需用运营邮箱完成收信检查。'
info "每日备份保留 14 天，位置：$(config_value BACKUP_DIR)。请同步到另一台机器。"
