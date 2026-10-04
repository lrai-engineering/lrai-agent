#!/usr/bin/env bash
# Initial Linux runtime installation. Run as the checkout owner, not root.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/install-runtime.sh

Builds and checks this checkout, creates the lrai-agent service account, and
installs a packaged runtime and Node under /opt/lrai-agent using sudo.
Requires Linux, Node.js >=22, npm, Git, and sudo already installed.

This is an initial installer: an existing /opt/lrai-agent runtime is refused.
Existing credentials and spool files are preserved. No services are installed
or started, and no provider login, HTTPS, or preview deployment is configured.
EOF
}

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  usage
  exit 0
fi
if (( $# != 0 )); then usage >&2; exit 2; fi
if (( EUID == 0 )); then
  echo 'Run as your normal checkout user; the installer uses sudo only for host installation.' >&2
  exit 1
fi
if [[ $(uname -s) != Linux ]]; then echo 'Linux is required.' >&2; exit 1; fi
for command in node npm git sudo readlink install mktemp; do
  command -v "$command" >/dev/null || { echo "Missing prerequisite: $command" >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 or newer is required"); process.exit(1); }'

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
node_binary=$(readlink -f -- "$(command -v node)")
npm_binary=$(readlink -f -- "$(command -v npm)")
cd "$repo"

sudo -v
assert_fresh_runtime() {
  if sudo test -e /opt/lrai-agent/bin/node ||
     sudo test -e /opt/lrai-agent/lib/node_modules/@lrai-engineering/lrai-agent; then
    echo 'Existing runtime detected under /opt/lrai-agent; use the documented update procedure.' >&2
    exit 1
  fi
}
assert_fresh_runtime

# Keep repository lifecycle scripts and validation under the invoking user.
npm ci
npm run check
package_dir=$(mktemp -d)
trap 'rm -rf -- "$package_dir"' EXIT
package_name=$(npm pack --ignore-scripts --pack-destination "$package_dir")
[[ $package_name != */* && -f "$package_dir/$package_name" ]] || {
  echo 'npm pack did not return a package filename.' >&2; exit 1;
}
assert_fresh_runtime

if ! id lrai-agent >/dev/null 2>&1; then
  sudo useradd --system --user-group --create-home \
    --home-dir /var/lib/lrai-agent --shell /usr/sbin/nologin lrai-agent
fi
sudo install -d -o lrai-agent -g lrai-agent -m 0700 \
  /var/lib/lrai-agent /var/lib/lrai-agent/webhook-spool \
  /var/lib/lrai-agent/.codex /var/lib/lrai-agent/.claude \
  /var/lib/lrai-agent/.config
sudo install -d -o root -g lrai-agent -m 0750 /etc/lrai-agent
sudo install -d -o root -g root -m 0755 /opt/lrai-agent/bin
sudo install -m 0755 "$node_binary" /opt/lrai-agent/bin/node

# Install the tarball, not a symlink into the operator's home. Lifecycle scripts
# have already run unprivileged above and must not run as root here.
sudo env PATH=/opt/lrai-agent/bin:/usr/bin:/bin \
  /opt/lrai-agent/bin/node "$npm_binary" install --global \
  --prefix /opt/lrai-agent --omit=dev --ignore-scripts \
  "$package_dir/$package_name"
sudo -u lrai-agent /opt/lrai-agent/bin/node \
  /opt/lrai-agent/lib/node_modules/@lrai-engineering/lrai-agent/dist/src/index.js --help

cat <<'EOF'

Runtime installed and service-user CLI access verified.
No services have been installed or started.
Next: docs/wiki/VM-Setup.md, starting with the worker toolchain requirements
at the end of section 2, then provider login, App credentials, and services.
EOF
