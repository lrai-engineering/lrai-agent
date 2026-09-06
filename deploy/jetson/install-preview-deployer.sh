#!/usr/bin/env bash
set -euo pipefail

agent_repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
gateway_repo=/home/luke/jetson-app-gateway

test -x "$agent_repo/deploy/jetson/lrai-agent-preview-deploy.sh"
test -f "$gateway_repo/deploy/lrai-jetson-preview.service"
test -f "$gateway_repo/compose.yaml"

# Install the checked-out worker package into the prefix used by the systemd
# unit. This updates the webhook/worker code before the service is restarted.
node_bin=$(command -v node || true)
npm_bin=$(command -v npm || true)
if test -z "$node_bin"; then
  for candidate in /home/luke/.nvm/versions/node/*/bin/node; do
    if test -x "$candidate"; then
      node_bin=$candidate
    fi
  done
fi
if test -z "$npm_bin"; then
  for candidate in /home/luke/.nvm/versions/node/*/bin/npm; do
    if test -x "$candidate"; then
      npm_bin=$candidate
    fi
  done
fi
if test -z "$node_bin" || test -z "$npm_bin"; then
  echo "Node.js/npm were not found; install Node.js/npm or expose them in PATH" >&2
  exit 1
fi

# Installing a local directory with npm creates a symlink. That is not
# readable by the hardened systemd unit because it points into /home/luke.
# Pack first so the global installation is a real copy under /opt/lrai-agent.
package_tmp=$(mktemp -d /tmp/lrai-agent-package.XXXXXX)
trap 'rm -rf "$package_tmp"' EXIT
package_tarball=$(cd "$agent_repo" && "$npm_bin" pack --ignore-scripts --pack-destination "$package_tmp")
"$npm_bin" install --global --prefix /opt/lrai-agent --omit=dev "$package_tmp/$package_tarball"

install -d -m 0755 /var/lib/lrai-agent/previews/gateway
if test ! -e /var/lib/lrai-agent/previews/gateway/previews.conf; then
  install -m 0644 /dev/null /var/lib/lrai-agent/previews/gateway/previews.conf
fi
install -d -m 0755 /var/lib/lrai-agent/previews/apps/calify

install -m 0755 \
  "$agent_repo/deploy/jetson/lrai-agent-preview-deploy.sh" \
  /usr/local/sbin/lrai-agent-preview-deploy
install -m 0440 \
  "$agent_repo/deploy/jetson/lrai-agent-preview.sudoers" \
  /etc/sudoers.d/lrai-agent-preview
visudo -cf /etc/sudoers.d/lrai-agent-preview

install -m 0644 \
  "$agent_repo/deploy/jetson/lrai-agent-worker.service" \
  /etc/systemd/system/lrai-agent-worker.service
install -m 0644 \
  "$gateway_repo/deploy/lrai-jetson-preview.service" \
  /etc/systemd/system/lrai-jetson-preview.service

systemctl daemon-reload
systemctl restart lrai-agent-webhook.service
systemctl restart lrai-agent-worker.service
systemctl restart lrai-jetson-preview.service

echo "Preview deployer installed. The worker now accepts deploy labels for allowlisted Calify previews."
