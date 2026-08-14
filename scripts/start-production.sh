#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
. ./.runtime.env
set +a
exec /usr/local/lighthouse/softwares/nodejs/node-v22.12.0-linux-x64/bin/node --experimental-sqlite server.js