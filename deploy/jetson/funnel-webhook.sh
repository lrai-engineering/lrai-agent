#!/usr/bin/env bash
set -euo pipefail

# Port 8443 is deliberate: the existing private Tailscale Serve gateway owns
# port 443. This exposes only the dedicated localhost webhook receiver.
exec sudo tailscale funnel --bg --https=8443 http://127.0.0.1:8095
