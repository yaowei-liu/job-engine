#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/job-engine}"
BRANCH="${BRANCH:-main}"

cd "$APP_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PORT="${PORT:-3030}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${PORT}/health}"

git fetch --all
git checkout "$BRANCH"
git pull origin "$BRANCH"
mkdir -p data
docker compose up -d --build
docker compose ps

attempt=1
max_attempts=20
until curl --fail --silent --show-error "$HEALTH_URL" >/dev/null; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "Health check failed after ${max_attempts} attempts: ${HEALTH_URL}" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 3
done

echo "Deploy healthy: ${HEALTH_URL}"
