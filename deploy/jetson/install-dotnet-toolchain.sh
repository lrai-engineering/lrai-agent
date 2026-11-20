#!/usr/bin/env bash
set -euo pipefail

# Copy a verified .NET SDK into the worker toolchain for host-owned .NET
# validation (lukasijus/IQPractice). The worker sandbox mounts only the
# toolchain prefix, so the SDK cannot be used from a user's home directory.
#
# Usage: sudo bash deploy/jetson/install-dotnet-toolchain.sh [SDK_DIR]
# SDK_DIR defaults to ~/.dotnet of the user who invoked sudo.
expected_sdk=10.0.403
toolchain=/opt/lrai-agent
target=$toolchain/dotnet

[[ "$EUID" == 0 ]] || { echo "Run this script with sudo." >&2; exit 1; }
invoking_home=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)
source_dir=${1:-$invoking_home/.dotnet}
[[ -x "$source_dir/dotnet" ]] || { echo "No dotnet executable in $source_dir" >&2; exit 1; }
[[ -d "$source_dir/sdk/$expected_sdk" ]] || {
  echo "$source_dir does not contain SDK $expected_sdk (the version the worker policy pins)." >&2; exit 1;
}
test -x "$toolchain/bin/node" || { echo "No worker toolchain at $toolchain" >&2; exit 1; }

staging=$(mktemp -d "$toolchain/.dotnet-staging.XXXXXX")
trap 'rm -rf -- "$staging"' EXIT
# Only the SDK distribution: no first-use sentinels, telemetry or tool caches.
for entry in dotnet host packs sdk sdk-manifests shared templates LICENSE.txt ThirdPartyNotices.txt; do
  [[ -e "$source_dir/$entry" ]] && cp -a --no-preserve=ownership "$source_dir/$entry" "$staging/"
done
chown -R root:root "$staging"
chmod -R u+rwX,go+rX,go-w "$staging"
chmod 0755 "$staging"
version=$(DOTNET_ROOT="$staging" DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 \
  DOTNET_CLI_HOME="$staging/.probe" "$staging/dotnet" --version)
rm -rf -- "$staging/.probe"
[[ "$version" == "$expected_sdk" ]] || { echo "Staged SDK reports $version, expected $expected_sdk" >&2; exit 1; }

if [[ -e "$target" ]]; then
  previous=$(mktemp -d "$toolchain/dotnet-backup.XXXXXX")
  mv -- "$target" "$previous/dotnet"
  echo "Previous SDK moved to $previous"
fi
mv -- "$staging" "$target"
trap - EXIT
ln -sfn ../dotnet/dotnet "$toolchain/bin/dotnet"
sudo -u lrai-agent env -i PATH="$toolchain/bin:/usr/bin:/bin" HOME=/tmp \
  DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 "$toolchain/bin/dotnet" --version
echo ".NET SDK $expected_sdk installed at $target"
