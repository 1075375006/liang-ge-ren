#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/ops/common.sh"
require_state
info "当前版本：$(config_value APP_IMAGE)"
compose ps
app_port=$(config_value APP_PORT); bind_address=$(config_value BIND_ADDRESS)
compose exec -T app node dist/scripts/check-ledger.js
compose exec -T worker node dist/scripts/worker-health.js
compose exec -T backup sh -c 'test -s /backups/.last-success && test "$(($(date +%s) - $(cat /backups/.last-success)))" -lt 93600'
curl --fail --silent --show-error --max-time 20 "http://${bind_address}:${app_port}/api/ready"
printf '\n'
