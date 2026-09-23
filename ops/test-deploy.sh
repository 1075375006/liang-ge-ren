#!/usr/bin/env bash
# Safe branch tests: fake Docker/curl; no real containers, mail, DNS or production data.
set -Eeuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mkdir -p "$ROOT/.local/ops-tests"
TEST_DIR=$(mktemp -d "$ROOT/.local/ops-tests/deploy.XXXXXX")
trap 'echo "Test artifacts retained: $TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/bin"
cat >"$TEST_DIR/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >>"$TEST_COMMAND_LOG"
case "$*" in
  *' ps -aq db') [[ ${TEST_EXISTING_DB:-false} != true ]] || printf 'fake-existing-db\n';;
  *'ps -aq'*'com.docker.compose.service=db'*) [[ ${TEST_EXISTING_CONTAINER:-false} != true ]] || printf 'fake-db-container\n';;
  'inspect --format {{.Image}} '*) printf 'sha256:%064d\n' 1;;
  *'fake-db-container'*) printf 'POSTGRES_PASSWORD=recoveredpassword012345678901234567890123456789\n';;
  'image inspect --format {{index .RepoDigests 0}} '*) printf 'postgres@sha256:%064d\n' 1;;
  'volume inspect'*) [[ ${TEST_EXISTING_VOLUME:-false} == true ]] && exit 0; exit 1;;
  'build '*) [[ ${TEST_FAIL:-} != build ]] || exit 41;;
  *'exec -T db sh -c pg_dump'*) [[ ${TEST_FAIL:-} != backup ]] || exit 42; printf 'test-archive\n';;
  *'exec -T db pg_restore --list'*) read -r marker; [[ "$marker" == test-archive ]] || exit 43;;
  *'run --rm --no-deps migrate'*) [[ ${TEST_FAIL:-} != migrate ]] || exit 44;;
  *'run --rm --no-deps app node dist/scripts/check-ledger.js'*) [[ ${TEST_FAIL:-} != restore-ledger ]] || exit 45;;
  *'exec -T app node -e'*'/api/ready'*) [[ ${TEST_FAIL:-} != readiness ]] || exit 46;;
  'image inspect '*) echo 'image_id=sha256:fake-test-only';;
  *'images --format json'*) echo '[]';;
esac
DOCKER
cat >"$TEST_DIR/bin/curl" <<'CURL'
#!/usr/bin/env bash
line=$(grep '^APP_VERSION=' "$DEPLOY_STATE_DIR/production.env")
version=${line#*=}
version=${version:1:${#version}-2}
printf '{"ok":true,"version":"%s"}\n' "$version"
CURL
chmod +x "$TEST_DIR/bin/docker" "$TEST_DIR/bin/curl"
export PATH="$TEST_DIR/bin:$PATH"
export TEST_COMMAND_LOG="$TEST_DIR/commands.log"
export APP_URL=https://app.example.test SUPPORT_EMAIL=help@example.test SMTP_HOST=mail.example.test SMTP_FROM=hello@example.test
export SMTP_PASS='a$b!c\d"quoted'
export DEPLOY_STATE_DIR="$TEST_DIR/state"
export DEPLOY_ENV_FILE="$DEPLOY_STATE_DIR/production.env"
mkdir -p "$DEPLOY_STATE_DIR"
assert() { "$@" || { echo "FAIL: $*" >&2; exit 1; }; }
run_deploy() { bash "$ROOT/scripts/deploy.sh" >"$TEST_DIR/output.log" 2>&1; }

# --init is a local file operation. It must not inspect Docker or open any public URL.
: >"$TEST_COMMAND_LOG"
if ! bash "$ROOT/scripts/deploy.sh" --init >"$TEST_DIR/output.log" 2>&1; then echo 'FAIL --init rejected' >&2; exit 1; fi
assert test -s "$DEPLOY_ENV_FILE"
assert test ! -s "$TEST_COMMAND_LOG"
if grep -Eq 'DOMAIN|ACME|CADDY|HTTP_PORT|HTTPS_PORT' "$DEPLOY_ENV_FILE"; then echo 'FAIL external-proxy config retains removed domain/proxy settings' >&2; exit 1; fi
# A first ordinary run copies the template, generates a password, and starts the Docker deployment.
rm -f "$DEPLOY_ENV_FILE"
: >"$TEST_COMMAND_LOG"
if ! run_deploy; then echo 'FAIL default config did not deploy' >&2; exit 1; fi
assert test -s "$DEPLOY_ENV_FILE"
assert grep -Eq '^POSTGRES_PASSWORD="[a-zA-Z0-9]{32,}"$' "$DEPLOY_ENV_FILE"
assert grep -Eq '^APP_PORT=33442$' "$DEPLOY_ENV_FILE"
assert grep -Eq '^BIND_ADDRESS=127\.0\.0\.1$' "$DEPLOY_ENV_FILE"
# Existing volumes still require the operator to preserve the original password.
sed -i.bak -e 's#^APP_URL=.*#APP_URL=https://app.example.test#' -e 's#^SMTP_HOST=.*#SMTP_HOST=mail.example.test#' -e 's#^SMTP_FROM=.*#SMTP_FROM=hello@example.test#' -e 's#^SMTP_USER=.*#SMTP_USER=hello@example.test#' -e 's#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=#' "$DEPLOY_ENV_FILE"
rm -f "$DEPLOY_ENV_FILE.bak"
export TEST_EXISTING_VOLUME=true
if run_deploy; then echo 'FAIL existing volume adopted without configuration' >&2; exit 1; fi
assert grep -Eq '已有数据库卷|已有生产数据库卷|existing.*database|password' "$TEST_DIR/output.log"
unset TEST_EXISTING_VOLUME
export TEST_EXISTING_VOLUME=true TEST_EXISTING_CONTAINER=true
: >"$TEST_COMMAND_LOG"
if ! run_deploy; then echo 'FAIL existing container password was not recovered' >&2; exit 1; fi
assert grep -Eq '已从同一 Compose 项目的数据库容器恢复数据库密码' "$TEST_DIR/output.log"
assert grep -Eq '^POSTGRES_PASSWORD="recoveredpassword012345678901234567890123456789"$' "$DEPLOY_ENV_FILE"
unset TEST_EXISTING_VOLUME TEST_EXISTING_CONTAINER
# A build failure after recovery must still leave the running services untouched.
sed -i.bak -e 's#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=#' "$DEPLOY_ENV_FILE"
rm -f "$DEPLOY_ENV_FILE.bak"
export TEST_FAIL=build
: >"$TEST_COMMAND_LOG"
if run_deploy; then echo 'FAIL build failure ignored' >&2; exit 1; fi
assert test -s "$DEPLOY_STATE_DIR/production.env"
if grep -Eq ' stop ' "$TEST_COMMAND_LOG"; then echo 'FAIL build failure stopped services' >&2; exit 1; fi
old_password=$(sed -n '/^POSTGRES_PASSWORD=/p' "$DEPLOY_STATE_DIR/production.env")
if grep -Fq "$SMTP_PASS" "$TEST_DIR/output.log"; then echo 'FAIL secret leaked' >&2; exit 1; fi
if [[ $(uname -s) == Linux ]]; then mode=$(stat -c %a "$DEPLOY_STATE_DIR/production.env"); else mode=$(stat -f %Lp "$DEPLOY_STATE_DIR/production.env"); fi
[[ "$mode" == 600 ]] || { echo 'FAIL configuration permissions' >&2; exit 1; }

export TEST_FAIL=migrate
: >"$TEST_COMMAND_LOG"
# Poisoned shell exports cannot change the deployment's persisted credentials.
export POSTGRES_PASSWORD=unsafe APP_URL=https://other.example.test
if run_deploy; then echo 'FAIL migration failure ignored' >&2; exit 1; fi
assert test -s "$DEPLOY_STATE_DIR/previous.env"
assert test ! -d "$DEPLOY_STATE_DIR/operation.lock"
assert test "$old_password" = "$(sed -n '/^POSTGRES_PASSWORD=/p' "$DEPLOY_STATE_DIR/production.env")"
assert grep -Eq 'stop app worker backup' "$TEST_COMMAND_LOG"
assert grep -Eq '升级失败' "$TEST_DIR/output.log"
assert test "$(find "$DEPLOY_STATE_DIR/backups" -name 'before-deploy-*.dump' | wc -l | tr -d ' ')" -ge 2

unset TEST_FAIL
: >"$TEST_COMMAND_LOG"
export TEST_EXISTING_DB=true
run_deploy
if grep -Eq ' pull db| pull .*backup' "$TEST_COMMAND_LOG"; then echo 'FAIL application update pulls a new database image' >&2; exit 1; fi
assert grep -Eq 'up -d --no-recreate --pull never --wait --wait-timeout 120 db' "$TEST_COMMAND_LOG"
assert grep -Eq '^POSTGRES_IMAGE="postgres@sha256:' "$DEPLOY_STATE_DIR/production.env"
assert test -s "$DEPLOY_STATE_DIR/last-success.env"
assert test -s "$DEPLOY_STATE_DIR/releases.log"
assert grep -Eq 'app.example.test' "$DEPLOY_ENV_FILE"
if grep -Eq 'other.example.test|unsafe' "$DEPLOY_ENV_FILE"; then echo 'FAIL shell overrides persistent config' >&2; exit 1; fi
# Test config values are data, never shell code.
printf "EVIL='\$(touch %s)'\n" "$TEST_DIR/should-not-exist" >>"$DEPLOY_STATE_DIR/production.env"
bash -c 'source "$1/ops/common.sh"; require_state; config_value EVIL >/dev/null' _ "$ROOT"
assert test ! -e "$TEST_DIR/should-not-exist"
# Missing confirmation and bad checksum fail before stopping or restoring a database.
: >"$TEST_COMMAND_LOG"
printf 'test-archive\n' >"$TEST_DIR/bad.dump"
printf 'bad-sha  bad.dump\n' >"$TEST_DIR/bad.dump.sha256"
if bash "$ROOT/scripts/restore.sh" "$TEST_DIR/bad.dump" >"$TEST_DIR/restore.log" 2>&1; then echo 'FAIL missing confirmation' >&2; exit 1; fi
if bash "$ROOT/scripts/restore.sh" "$TEST_DIR/bad.dump" --confirm-replace-database >"$TEST_DIR/restore.log" 2>&1; then echo 'FAIL bad checksum accepted' >&2; exit 1; fi
if grep -Eq 'stop |DROP SCHEMA|--single-transaction|down.*-v' "$TEST_COMMAND_LOG"; then echo 'FAIL unsafe restore side effect' >&2; exit 1; fi
archive=$(bash "$ROOT/scripts/backup.sh" 2>"$TEST_DIR/backup.log")
export TEST_FAIL=restore-ledger
: >"$TEST_COMMAND_LOG"
if bash "$ROOT/scripts/restore.sh" "$archive" --confirm-replace-database >"$TEST_DIR/restore.log" 2>&1; then echo 'FAIL restore ledger failure ignored' >&2; exit 1; fi
assert grep -Eq 'run --rm --no-deps app node dist/scripts/check-ledger.js' "$TEST_COMMAND_LOG"
assert test "$(grep -c 'stop app worker backup' "$TEST_COMMAND_LOG")" -ge 2
if grep -Eq 'up -d.*app|caddy|proxy' "$TEST_COMMAND_LOG"; then echo 'FAIL broken ledger exposed restored services' >&2; exit 1; fi
export TEST_FAIL=readiness
for operation in restore deploy; do
  : >"$TEST_COMMAND_LOG"
  if [[ "$operation" == restore ]]; then
    if bash "$ROOT/scripts/restore.sh" "$archive" --confirm-replace-database >"$TEST_DIR/restore.log" 2>&1; then echo 'FAIL restore readiness failure ignored' >&2; exit 1; fi
  else
    if run_deploy; then echo 'FAIL deploy readiness failure ignored' >&2; exit 1; fi
  fi
  assert test "$(grep -c 'stop app worker backup' "$TEST_COMMAND_LOG")" -ge 2
  if grep -Eq 'caddy|up -d.*proxy' "$TEST_COMMAND_LOG"; then echo 'FAIL readiness failure exposed proxy' >&2; exit 1; fi
done
unset TEST_FAIL
printf 'PASS: deployment validation, safe build failure, secret persistence, migration failure retention, success, literal env parsing, restore guards, ledger/readiness failure isolation\n'
