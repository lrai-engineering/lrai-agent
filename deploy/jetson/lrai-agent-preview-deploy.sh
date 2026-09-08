#!/usr/bin/env bash
set -Eeuo pipefail
# Never print command text here: it may contain authentication material.
trap 'status=$?; echo "preview deployer failed at line $LINENO (exit $status)" >&2; exit "$status"' ERR

# This script is intended to be installed root-owned and invoked through a
# narrow sudoers rule. It deliberately supports only the known Calify target
# until each other application has an equivalent preview contract.

usage() {
  echo "usage: $0 --repository owner/repo --pull-request N --ref REF --sha SHA --app APP --context-sha SHA256" >&2
  exit 2
}

repository=
pull_request=
ref=
sha=
app=
context_sha=
while (($# > 0)); do
  case "$1" in
    --repository) repository=${2-}; shift 2 ;;
    --pull-request) pull_request=${2-}; shift 2 ;;
    --ref) ref=${2-}; shift 2 ;;
    --sha) sha=${2-}; shift 2 ;;
    --app) app=${2-}; shift 2 ;;
    --context-sha) context_sha=${2-}; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$repository" == "lukasijus/calify" ]] || { echo "preview repository is not allowlisted" >&2; exit 1; }
[[ "$app" == "calify" ]] || { echo "preview app is not allowlisted" >&2; exit 1; }
[[ "$pull_request" =~ ^[1-9][0-9]*$ ]] || { echo "invalid pull request number" >&2; exit 1; }
[[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "invalid git ref" >&2; exit 1; }
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid commit SHA" >&2; exit 1; }
[[ "$context_sha" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid deployment context SHA" >&2; exit 1; }
[[ -n "${LRAI_GITHUB_TOKEN:-}" ]] || { echo "LRAI_GITHUB_TOKEN is required" >&2; exit 1; }

# The worker service protects the root filesystem, so Docker's default
# /root/.docker client directory is not writable in its service namespace.
export DOCKER_CONFIG="${DOCKER_CONFIG:-/var/lib/lrai-agent/.docker}"
mkdir -p "$DOCKER_CONFIG"

preview_root=/var/lib/lrai-agent/previews
target_root="$preview_root/apps/calify"
mkdir -p "$target_root" "$preview_root/gateway"
# Serialize the shared gateway configuration as well as deployments of one PR.
exec 9>"$preview_root/.deploy.lock"
flock -x 9
route="/calify-pr-$pull_request"
project="calify-pr-$pull_request"
container="$project"
local_url="http://127.0.0.1:8090$route"
url="https://jetson.tail68fd31.ts.net$route"
state_file="$target_root/$project.context-sha"
existing_repository=$(docker inspect --format '{{ index .Config.Labels "com.lrai-agent.preview.repository" }}' "$container" 2>/dev/null || true)
existing_pull_request=$(docker inspect --format '{{ index .Config.Labels "com.lrai-agent.preview.pull-request" }}' "$container" 2>/dev/null || true)
existing_sha=$(docker inspect --format '{{ index .Config.Labels "com.lrai-agent.preview.sha" }}' "$container" 2>/dev/null || true)
existing_status=$(docker inspect --format '{{ .State.Status }}' "$container" 2>/dev/null || true)
existing_context=$(cat "$state_file" 2>/dev/null || true)
if [[ "$existing_repository" == "$repository" && "$existing_pull_request" == "$pull_request" && "$existing_sha" == "$sha" && "$existing_context" == "$context_sha" && "$existing_status" == "running" ]] &&
  curl --fail --silent --show-error --max-time 10 "$local_url" >/dev/null 2>&1 &&
  curl --fail --silent --show-error --max-time 10 "$url" >/dev/null 2>&1; then
  printf '{"status":"unchanged","url":"%s"}\n' "$url"
  exit 0
fi

staging=$(mktemp -d "$target_root/.deploy.XXXXXX")
askpass=$(mktemp "$preview_root/.askpass.XXXXXX")
compose_log=$(mktemp "$preview_root/.compose.XXXXXX")
cleanup() {
  local status=$?
  trap - ERR
  set +e
  rm -f -- "$askpass"
  rm -f -- "$compose_log"
  if [[ -n "$staging" ]]; then rm -rf -- "$staging"; fi
  exit "$status"
}
trap cleanup EXIT

cat >"$askpass" <<'ASKPASS'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' x-access-token ;;
  *) printf '%s\n' "$LRAI_GITHUB_TOKEN" ;;
esac
ASKPASS
chmod 0700 "$askpass"

GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$askpass" git clone --quiet --branch "$ref" --single-branch \
  "https://github.com/$repository.git" "$staging"
actual_sha=$(git -C "$staging" rev-parse HEAD)
[[ "$actual_sha" == "$sha" ]] || { echo "checked-out ref does not match requested commit" >&2; exit 1; }

override="$staging/.preview-compose.yaml"
cat >"$override" <<COMPOSE
services:
  calify:
    build:
      args:
        CALIFY_BASE_PATH: $route
    container_name: $container
    ports: !reset []
    labels:
      com.lrai-agent.preview.repository: "$repository"
      com.lrai-agent.preview.pull-request: "$pull_request"
      com.lrai-agent.preview.sha: "$sha"
    networks:
      - calify_default
networks:
  calify_default:
    external: true
    name: calify_default
COMPOSE

if docker compose -p "$project" -f "$staging/compose.yaml" -f "$override" up -d --build --force-recreate calify >"$compose_log" 2>&1; then
  :
else
  preview_status=$?
  echo "preview compose failed ($preview_status)" >&2
  tail -n 40 "$compose_log" >&2 || true
  exit "$preview_status"
fi
# Compose adds its service name "calify" as a network alias. On the shared
# network that collides with the canonical main container. Keep only the PR's
# unique name, otherwise an Nginx reload can route /calify to a PR at random.
preview_aliases=$(docker inspect --format '{{json (index .NetworkSettings.Networks "calify_default").Aliases}}' "$container")
if [[ "$preview_aliases" == *'"calify"'* ]]; then
  docker network disconnect calify_default "$container" >>"$compose_log" 2>&1
  docker network connect --alias "$container" calify_default "$container" >>"$compose_log" 2>&1
fi
mkdir -p "$target_root"
rm -rf -- "$target_root/current"
mv -- "$staging" "$target_root/current"
staging=

route_dir="$preview_root/gateway/routes"
route_file="$route_dir/$project.conf"
routes_file="$preview_root/gateway/previews.conf"
mkdir -p "$route_dir"
cat >"$route_file" <<NGINX
location = $route {
  proxy_pass http://$container:80;
  proxy_http_version 1.1;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$upstream_forwarded_proto;
}

location ^~ $route/ {
  proxy_pass http://$container:80;
  proxy_http_version 1.1;
  proxy_set_header Host \$host;
  proxy_set_header X-Real-IP \$remote_addr;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$upstream_forwarded_proto;
}
NGINX

routes_tmp=$(mktemp "$preview_root/gateway/.previews.XXXXXX")
for route_config in "$route_dir"/*.conf; do
  [[ -f "$route_config" ]] && cat "$route_config" >>"$routes_tmp"
done
# Keep the inode: Docker bind-mounts this file into the running gateway.
cat "$routes_tmp" >"$routes_file"
rm -f -- "$routes_tmp"

# The route file is mounted into the already-built gateway image. Rebuilding
# the gateway for every preview adds an unnecessary BuildKit outage window.
gateway_status=0
if docker compose -f /home/luke/jetson-app-gateway/compose.yaml up -d gateway >>"$compose_log" 2>&1; then
  :
else
  gateway_status=$?
  echo "warning: gateway compose returned $gateway_status; validating the live route" >&2
fi

# A previous updater or boot job may have replaced the bind-mounted file's
# inode. Reloading Nginx cannot refresh that stale mount; recreate only when
# the container actually sees different route contents.
if ! docker exec jetson-app-gateway cat /etc/nginx/previews.conf | cmp -s "$routes_file" -; then
  echo "Gateway route mount is stale; recreating the gateway container" >&2
  docker compose -f /home/luke/jetson-app-gateway/compose.yaml up -d --force-recreate gateway >>"$compose_log" 2>&1 || { tail -n 40 "$compose_log" >&2; exit 1; }
  docker exec jetson-app-gateway cat /etc/nginx/previews.conf | cmp -s "$routes_file" - || { echo "gateway still sees stale preview routes" >&2; exit 1; }
fi

# Nginx must load new routes and resolve a recreated preview container's IP.
docker exec jetson-app-gateway nginx -t >>"$compose_log" 2>&1 || { tail -n 40 "$compose_log" >&2; exit 1; }
docker exec jetson-app-gateway nginx -s reload >>"$compose_log" 2>&1 || { tail -n 40 "$compose_log" >&2; exit 1; }

# Confirm the container matches the requested commit before publishing success.
deployed_sha=$(docker inspect --format '{{ index .Config.Labels "com.lrai-agent.preview.sha" }}' "$container" 2>/dev/null || true)
deployed_status=$(docker inspect --format '{{ .State.Status }}' "$container" 2>/dev/null || true)
if [[ "$deployed_sha" != "$sha" || "$deployed_status" != "running" ]]; then
  echo "preview container is not running the requested commit: sha=$deployed_sha status=$deployed_status" >&2
  tail -n 40 "$compose_log" >&2 || true
  exit 1
fi

for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 5 "$local_url" >/dev/null 2>&1 &&
    curl --fail --silent --show-error --max-time 5 "$url" >/dev/null 2>&1; then
    state_tmp=$(mktemp "$target_root/.context.XXXXXX")
    printf '%s\n' "$context_sha" >"$state_tmp"
    mv -- "$state_tmp" "$state_file"
    printf '{"status":"deployed","url":"%s"}\n' "$url"
    exit 0
  fi
  sleep 2
done
echo "preview health check failed: $local_url and $url" >&2
tail -n 40 "$compose_log" >&2 || true
exit 1
