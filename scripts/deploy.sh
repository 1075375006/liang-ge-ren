#!/usr/bin/env bash
# Non-interactive production deployment; existing secrets and data are preserved.
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/ops/common.sh"

if [[ ${1:-} == '--help' ]]; then
  cat <<'HELP'
首次部署：直接运行 bash scripts/deploy.sh；脚本会生成默认 production.env、随机数据库密码并启动 Docker 服务。
也可运行 bash scripts/deploy.sh --init 只创建配置模板，不启动服务；支持 DEPLOY_ENV_FILE 指定另一个绝对路径。
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
  info '默认端口、数据库和反代设置已填好；按需修改 APP_URL/TRUST_PROXY，SMTP/微信进入 /admin 后台，再运行 bash scripts/deploy.sh。'
  exit 0
fi
[[ $# -eq 0 ]] || die '只支持 --help 或 --init'

validate_config() {
  local app_url support password
  app_url=$(config_value APP_URL); support=$(config_value SUPPORT_EMAIL); password=$(config_value POSTGRES_PASSWORD)
  [[ -z "$app_url" || "$app_url" =~ ^https?://[^/[:space:]]+/?$ ]] || die 'APP_URL 地址格式无效'
  [[ -z "$support" || "$support" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die 'SUPPORT_EMAIL 格式无效'
  [[ "$password" =~ ^[a-zA-Z0-9]{32,}$ ]] || die '生产数据库密码必须至少 32 位随机字母数字'
  [[ "$(config_value APP_PORT)" =~ ^[0-9]+$ ]] || die 'APP_PORT 必须是数字'
}

for command in docker git openssl curl; do need "$command"; done
docker info >/dev/null 2>&1 || die 'Docker 服务不可用，请先启动 Docker 或使用 ops/install.sh 安装'
docker compose version >/dev/null 2>&1 || die '需要 Docker Compose v2 或更新版本'
if [[ -s "$ENV_FILE" ]]; then
  grep -q 'your-domain\|your-provider' "$ENV_FILE" && die "请先编辑配置文件：$ENV_FILE"
  info "保留现有配置：${ENV_FILE}（本次 shell 的配置变量不会覆盖已有值）"
else
  mkdir -p "$(dirname "$ENV_FILE")"
  cp "$ROOT/production.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info "已创建默认生产配置：${ENV_FILE}（端口 33442；域名、SMTP、微信可在部署后按需配置）"
fi
if [[ -z "$(config_value POSTGRES_PASSWORD)" ]]; then
  project=$(config_value COMPOSE_PROJECT_NAME); project=${project:-liang-ge-ren-production}
  if docker volume inspect "${project}_postgres_data" >/dev/null 2>&1; then
    database_container=$(docker ps -aq \
      --filter "label=com.docker.compose.project=${project}" \
      --filter 'label=com.docker.compose.service=db' | head -n 1)
    recovered_password=''
    if [[ -n "$database_container" ]]; then
      recovered_password=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$database_container" |
        awk -F= '$1 == "POSTGRES_PASSWORD" { print substr($0, index($0, "=") + 1); exit }')
    fi
    if [[ "$recovered_password" =~ ^[a-zA-Z0-9]{32,}$ ]]; then
      set_config POSTGRES_PASSWORD "$recovered_password"
      info '已从同一 Compose 项目的数据库容器恢复数据库密码；不会覆盖数据库卷'
    else
      die '已有数据库卷但密码为空，且找不到同一 Compose 项目数据库容器中的原密码；请恢复原 production.env，不会接管数据'
    fi
  else
    set_config POSTGRES_PASSWORD "$(openssl rand -hex 32)"
  fi
fi
validate_config
acquire_lock
mkdir -p "$STATE_DIR/backups"
chmod 700 "$STATE_DIR/backups"
set_config DEPLOY_STATE_DIR "$STATE_DIR"
if [[ $(id -u) -eq 0 ]]; then chown 1000:1000 "$STATE_DIR" 2>/dev/null || true; fi
if [[ ! -s "$STATE_DIR/admin.bootstrap" ]]; then
  openssl rand -hex 32 >"$STATE_DIR/admin.bootstrap"
  chmod 600 "$STATE_DIR/admin.bootstrap"
  info "管理员首次初始化令牌已生成：$STATE_DIR/admin.bootstrap（读取后仅通过 /admin/setup 使用一次）"
fi
if [[ $(id -u) -eq 0 ]]; then chown 1000:1000 "$STATE_DIR/admin.bootstrap" 2>/dev/null || true; fi
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
ready=false
for attempt in {1..15}; do
  if curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "http://${bind_address}:${app_port}/api/ready" >"$STATE_DIR/last-readiness.json"; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  info '容器内就绪，但宿主机端口仍无法访问；当前 Compose 端口映射如下：'
  compose port app 33442 || true
  compose ps app || true
  die "本机应用端口 ${bind_address}:${app_port} 未就绪，请检查 Docker 端口发布或 BIND_ADDRESS"
fi
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
