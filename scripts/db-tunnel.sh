#!/usr/bin/env bash
# Opens an SSH tunnel through the Lightsail bastion to the RDS instance,
# forwarding a local port so `src/db/pool.ts` can connect via `localhost`.
# Blocks in the foreground (Ctrl+C to close) -- run this in its own terminal
# and leave it running while you use `npm run smoke:db-check` or any other
# DB-touching script.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

missing=()
for var in SSH_TUNNEL_HOST RDS_ENDPOINT RDS_PORT LOCAL_TUNNEL_PORT; do
  if [ -z "${!var:-}" ]; then
    missing+=("$var")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing required env var(s): ${missing[*]}" >&2
  echo "Copy .env.example to .env and fill in the missing values." >&2
  exit 1
fi

echo "Opening tunnel: localhost:${LOCAL_TUNNEL_PORT} -> ${RDS_ENDPOINT}:${RDS_PORT} via ${SSH_TUNNEL_HOST}"
exec ssh -N -L "${LOCAL_TUNNEL_PORT}:${RDS_ENDPOINT}:${RDS_PORT}" "${SSH_TUNNEL_HOST}"
