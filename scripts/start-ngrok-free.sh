#!/usr/bin/env bash
set -euo pipefail

: "${NGROK_AUTHTOKEN:?Set NGROK_AUTHTOKEN with your free ngrok token before running this script. Example: export NGROK_AUTHTOKEN=...}"

export NGROK_AUTHTOKEN
ngrok config add-authtoken "$NGROK_AUTHTOKEN" >/dev/null

echo "Starting ngrok tunnel to http://localhost:4000 ..."
ngrok http 4000
