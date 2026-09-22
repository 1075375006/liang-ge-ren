#!/usr/bin/env bash
# Run on the target Linux host. The installer creates production.env with safe
# defaults, generates a database password, and starts the Docker services.
set -Eeuo pipefail
umask 077
fail() { echo "错误：$*" >&2; exit 1; }
[[ $(uname -s) == Linux ]] || fail '此引导入口仅支持 Linux 服务器；本地请使用 scripts/deploy.sh'
INSTALL_DIR=${INSTALL_DIR:-/opt/liang-ge-ren}
REPOSITORY=https://github.com/1075375006/liang-ge-ren.git
REF=${REF:-main}
[[ "$INSTALL_DIR" == /* ]] || fail 'INSTALL_DIR 必须是绝对路径'

if [[ $(id -u) -ne 0 ]]; then
  fail '请以 root 运行此安装入口（首次需安装系统软件并创建 /opt 目录），或提前安装 Docker 后在自己拥有的目录直接运行 scripts/deploy.sh'
fi
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  [[ -f /etc/os-release ]] || fail '无法识别系统，请先手动安装 Docker Engine、Compose v2、Git、OpenSSL、curl'
  # This is the operating system's trusted release metadata, not user deployment config.
  source /etc/os-release
  [[ "$ID" == ubuntu || "$ID" == debian ]] || fail '自动安装支持 Ubuntu / Debian；其他 Linux 请预装 Docker Engine、Compose v2、Git、OpenSSL、curl'
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl git openssl
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl --fail --silent --show-error --location "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$(dpkg --print-architecture)" "$ID" "${UBUNTU_CODENAME:-$VERSION_CODENAME}" >/etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
fi
if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker; fi
docker info >/dev/null 2>&1 || fail 'Docker 服务未就绪'

if [[ -e "$INSTALL_DIR" ]]; then
  [[ -d "$INSTALL_DIR/.git" ]] || fail "$INSTALL_DIR 已存在且不是项目 Git 仓库，未覆盖任何文件"
  existing_remote=$(git -C "$INSTALL_DIR" remote get-url origin)
  [[ "$existing_remote" == "$REPOSITORY" || "$existing_remote" == "${REPOSITORY%.git}" ]] || fail '安装目录的 origin 不是本项目，未修改'
  [[ -z $(git -C "$INSTALL_DIR" status --porcelain) ]] || fail '安装目录有未提交改动，未覆盖；请先提交或自行处理'
else
  git clone "$REPOSITORY" "$INSTALL_DIR"
fi
git -C "$INSTALL_DIR" fetch origin "$REF"
target=$(git -C "$INSTALL_DIR" rev-parse FETCH_HEAD)
git -C "$INSTALL_DIR" checkout --detach "$target"
exec bash "$INSTALL_DIR/scripts/deploy.sh"
