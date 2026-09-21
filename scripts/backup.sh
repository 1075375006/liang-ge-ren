#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/ops/common.sh"
require_state
acquire_lock
backup_database manual
printf '\n'
