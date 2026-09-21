#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/ops/common.sh"
[[ $# -eq 2 && "$2" == '--confirm-replace-database' ]] || die '用法：bash scripts/restore.sh /绝对路径/backup.dump --confirm-replace-database（覆盖当前数据库）'
archive=$1
[[ -f "$archive" && -s "$archive" ]] || die '备份文件不存在或为空'
require_state
acquire_lock
ensure_database
compose exec -T db pg_restore --list <"$archive" >/dev/null || die '不是有效 PostgreSQL 备份，当前数据库未修改'
if [[ -f "$archive.sha256" ]]; then
  actual=$(digest_file "$archive"); actual=${actual%% *}
  read -r expected _ <"$archive.sha256"
  [[ "$actual" == "$expected" ]] || die '备份 SHA256 不匹配，当前数据库未修改'
else
  die '缺少配套 .sha256 校验文件，当前数据库未修改'
fi
prior='尚未生成；未清空当前数据库'
on_failure() {
  local exit_code=$?
  trap - ERR
  compose stop caddy app worker backup || true
  info "恢复失败，应用保持停止以保护数据。恢复前备份为 ${prior}；排查后重跑恢复。"
  exit "$exit_code"
}
trap on_failure ERR
compose stop caddy app worker backup
prior=$(backup_database before-restore)
info "恢复前备份：$prior"
# Rebuild only the application schema so objects added after this backup cannot survive.
compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"'
compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error --single-transaction' <"$archive"
compose run --rm --no-deps migrate
compose run --rm --no-deps app node dist/scripts/check-ledger.js
compose up -d --no-deps --pull never --wait --wait-timeout 180 app worker backup
compose exec -T app node -e "fetch('http://127.0.0.1:33442/api/ready').then(r=>{if(!r.ok) throw new Error('恢复后的应用与后台尚未就绪')}).catch(e=>{console.error(e.message);process.exit(1)})"
compose up -d --no-deps caddy
info '数据库恢复、迁移和积分对账完成。'
