#!/usr/bin/env bash
# Non-interactive production deployment; existing secrets and data are preserved.
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/ops/common.sh"

if [[ ${1:-} == '--help' ]]; then
  cat <<'HELP'
首次部署：编辑项目根目录 production.env（可由 production.env.example 复制），然后运行 bash scripts/deploy.sh
也可运行 bash scripts/deploy.sh --init 创建配置模板；支持 DEPLOY_ENV_FILE 指定另一个绝对路径。
项目只监听 BIND_ADDRESS:APP_PORT，域名、HTTPS 和反向代理由你自己的 Nginx / Traefik / Caddy 管理。
Docker Compose v2+、Git、OpenSSL、curl 可用。
HELP
  exit 0
fi
if [[ ${1:-} == '--init' ]]; then
  [[ $# -eq 1 ]] || die '--init 不接受其他参数'
  mkdir -p "$(dirname "$ENV_FILE")"
  [[ -e "$ENV_FILE" ]] && die "配置已存在：$ENV_FILE"
  cp "$ROOT/production.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info "已创建生产配置：$ENV_FILE"
  info '请填写 APP_URL、SUPPORT_EMAIL、SMTP_* 和反向代理相关设置，再运行 bash scripts/deploy.sh。'
  exit 0
fi
[[ $# -eq 0 ]] || die '只支持 --help 或 --init'

validate_config() {
  local app_url support smtp from password
  app_url=$(config_value APP_URL); support=$(config_value SUPPORT_EMAIL); smtp=$(config_value SMTP_HOST); from=$(config_value SMTP_FROM); password=$(config_value POSTGRES_PASSWORD)
  [[ "$app_url" =~ ^https://[^/[:space:]]+/?$ ]] || die 'APP_URL 必须填写反向代理后的完整 HTTPS 地址（项目不会绑定它）'
  [[ "$support" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die '必须配置有效 SUPPORT_EMAIL'
  [[ -n "$smtp" && -n "$from" ]] || die '公开运营必须提供 SMTP_HOST 和 SMTP_FROM'
  [[ "$password" =~ ^[a-zA-Z0-9]{32,}$ ]] || die '生产数据库密码必须至少 32 位随机字母数字'
  [[ "$(config_value APP_PORT)" =~ ^[0-9]+$ ]] || die 'APP_PORT 必须是数字'
}

if [[ -s "$ENV_FILE" ]]; then
  if grep -q 'your-domain\|your-provider' "$ENV_FILE"; then die "请先编辑配置文件：$ENV_FILE"; fi
  if [[ -z "$(config_value POSTGRES_PASSWORD)" ]]; then
    project=$(config_value COMPOSE_PROJECT_NAME); project=${project:-liang-ge-ren-production}
    docker volume inspect "${project}_postgres_data" >/dev/null 2>&1 && die '已有数据库卷但密码为空，请填写原密码；不会接管数据'
    set_config POSTGRES_PASSWORD "$(openssl rand -hex 32)"
  fi
  validate_config
  info "保留现有配置：${ENV_FILE}（本次 shell 的配置变量不会覆盖已有值）"
else
  mkdir -p "$(dirname "$ENV_FILE")"; cp "$ROOT/production.env.example" "$ENV_FILE"; chmod 600 "$ENV_FILE"
  die "已创建配置文件：${ENV_FILE}；请填写 APP_URL、SUPPORT_EMAIL、SMTP_* 后重新运行"
fi
for command in docker git openssl curl; do need "$command"; done
docker info >/dev/null 2>&1 || die 'Docker 服务不可用，请先启动 Docker 或使用 ops/install.sh 安装'
docker compose version >/dev/null 2>&1 || die '需要 Docker Compose v2 或更新版本'
acquire_lock
mkdir -p "$STATE_DIR/backups"
chmod 700 "$STATE_DIR/backups"
if [[ "$(config_value BACKUP_DIR)" != /* ]]; then set_config BACKUP_DIR "$STATE_DIR/backups"; fi
chmod 600 "$ENV_FILE"
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
    compose stop app worker backup || true
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
compose stop app worker backup
prior_backup=$(backup_database before-deploy)
set_config APP_IMAGE "$candidate"
set_config APP_VERSION "$version"
compose run --rm --no-deps migrate
compose up -d --no-deps --pull never --wait --wait-timeout 180 app worker backup
compose exec -T app node dist/scripts/check-ledger.js
compose exec -T app node --input-type=module <"$ROOT/ops/check-smtp.mjs"
compose exec -T app node -e "fetch('http://127.0.0.1:33442/api/ready').then(async r=>{if(!r.ok) throw new Error(await r.text());console.log('应用与后台就绪')}).catch(e=>{console.error(e.message);process.exit(1)})"
app_port=$(config_value APP_PORT)
bind_address=$(config_value BIND_ADDRESS)
info "检查本机应用端口 ${bind_address}:${app_port}（域名和 HTTPS 由你的反向代理负责）"
curl --fail --silent --show-error --connect-timeout 3 --max-time 10 "http://${bind_address}:${app_port}/api/ready" >"$STATE_DIR/last-readiness.json"
grep -Eq '"version"[[:space:]]*:[[:space:]]*"'"$version"'"' "$STATE_DIR/last-readiness.json" || die '本机应用版本检查未通过'
maintenance=false
cp "$ENV_FILE" "$STATE_DIR/last-success.env"
{
  printf '%s version=%s image=%s previous=%s backup=%s\n' "$(date -u +%FT%TZ)" "$version" "$candidate" "$previous_image" "$prior_backup"
  docker image inspect --format 'image_id={{.Id}}' "$candidate"
  compose images --format json
} >>"$STATE_DIR/releases.log"
info "部署完成：应用监听 ${bind_address}:${app_port}"
info '数据库、后台、积分对账和本机就绪检查通过；请确认你的反向代理已转发到该端口。'
info "每日备份保留 14 天，位置：$(config_value BACKUP_DIR)。请同步到另一台机器。"
