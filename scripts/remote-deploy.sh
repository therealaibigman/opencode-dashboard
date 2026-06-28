#!/usr/bin/env bash
set -euo pipefail

APP_NAME="opencode-dashboard"
DEPLOY_PATH="/home/exedev/opencode-dashboard"
BRANCH="main"
PORT="3002"
HEALTH_URL="http://127.0.0.1:3002/api/health"

cd "$DEPLOY_PATH"

export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"

previous_ref="$(git rev-parse HEAD 2>/dev/null || true)"

rollback() {
  status="$?"
  if [ "$status" -eq 0 ]; then
    return 0
  fi
  echo "Deploy failed with status $status"
  if [ -n "$previous_ref" ]; then
    echo "Rolling back to $previous_ref"
    git reset --hard "$previous_ref" || true
    npm ci || true
    if npm pkg get scripts.build | grep -qv null; then npm run build || true; fi
    pm2 startOrReload ecosystem.config.cjs || true
    pm2 save || true
  fi
  exit "$status"
}
trap rollback EXIT

git fetch --prune origin "$BRANCH"
git reset --hard "origin/$BRANCH"

npm ci
if npm pkg get scripts.db:migrate | grep -qv null; then
  npm run db:migrate
fi
npm run build

pm2 startOrReload ecosystem.config.cjs
pm2 save

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    pm2 status "$APP_NAME"
    trap - EXIT
    exit 0
  fi
  sleep 2
done

echo "Health check failed: $HEALTH_URL"
exit 1
