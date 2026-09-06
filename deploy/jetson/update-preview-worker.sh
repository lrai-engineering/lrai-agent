#!/usr/bin/env bash
set -euo pipefail

# Apply the preview-result/worker-loop fix to an existing installation after
# running npm run check in the checkout. No gateway or webhook restart needed.
agent_repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
installed_worker=/opt/lrai-agent/lib/node_modules/@lrai-engineering/lrai-agent/dist/src/worker.js
installed_deployer=/usr/local/sbin/lrai-agent-preview-deploy
spool=/var/lib/lrai-agent/webhook-spool

[[ "$EUID" == 0 ]] || { echo "Run this script with sudo." >&2; exit 1; }
test -f "$installed_worker"
test -f "$installed_deployer"
test -f "$agent_repo/dist/src/worker.js"
test "$agent_repo/dist/src/worker.js" -nt "$agent_repo/src/worker.ts" || {
  echo "Run npm run check before installing this update." >&2; exit 1;
}
bash -n "$agent_repo/deploy/jetson/lrai-agent-preview-deploy.sh"
for task in "$spool"/*.processing "$spool"/*.json; do
  if [[ -f "$task" ]]; then
    echo "The worker has active or queued tasks; let it finish before updating." >&2
    exit 1
  fi
done

backup=$(mktemp -d /opt/lrai-agent/preview-worker-backup.XXXXXX)
install -m 0644 "$installed_worker" "$backup/worker.js"
install -m 0755 "$installed_deployer" "$backup/preview-deploy.sh"
echo "Previous files saved to $backup"

systemctl stop lrai-agent-worker.service
rollback() {
  local status=$?
  trap - EXIT
  install -m 0644 "$backup/worker.js" "$installed_worker"
  install -m 0755 "$backup/preview-deploy.sh" "$installed_deployer"
  systemctl start lrai-agent-worker.service
  exit "$status"
}
trap rollback EXIT
install -m 0644 "$agent_repo/dist/src/worker.js" "$installed_worker"
install -m 0755 "$agent_repo/deploy/jetson/lrai-agent-preview-deploy.sh" "$installed_deployer"
systemctl start lrai-agent-worker.service
systemctl is-active lrai-agent-worker.service
trap - EXIT
echo "Preview worker updated. Add deploy to the issue to request a preview."
