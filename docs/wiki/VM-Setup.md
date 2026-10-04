# VM setup

These are operator-run instructions for a Linux/systemd host. Complete [Prerequisites](Prerequisites.md) first. The portable worker setup below does not install a GitHub Actions runner.

## Initial runtime installer

On a fresh Linux VM with Node.js 22+, npm, Git, and sudo installed, clone this
repository and run the following as your normal user:

```bash
git clone https://github.com/lrai-engineering/lrai-agent.git
cd lrai-agent
bash scripts/install-runtime.sh
```

If already cloned, run only the last command from the checkout. The installer
runs `npm ci` and `npm run check`, creates the dedicated service account and
directories, installs Node and a real package under `/opt/lrai-agent`, and checks
CLI access as the service user. It preserves existing secrets and queued tasks
and refuses an existing runtime rather than upgrading it in place. Dependency
lifecycle scripts run as your normal user; the privileged package installation
disables them.

This replaces section 1 and the runtime build/install portion of section 2 below.
Continue with the Bubblewrap and pinned package-manager requirements at the end
of section 2, then sections 3 onward. Provider authentication, GitHub App
credentials, systemd services, HTTPS, and preview deployment are separate steps;
the installer does not configure or start them. Use the manual instructions below
when you need to inspect or customize each step.

## 1. Create the service account and directories

On a new host, first check `id lrai-agent`. If the account does not exist:

```bash
sudo useradd --system --user-group --create-home \
  --home-dir /var/lib/lrai-agent --shell /usr/sbin/nologin lrai-agent
```

Create the state and configuration directories:

```bash
sudo install -d -o lrai-agent -g lrai-agent -m 0700 /var/lib/lrai-agent
sudo install -d -o lrai-agent -g lrai-agent -m 0700 \
  /var/lib/lrai-agent/webhook-spool \
  /var/lib/lrai-agent/.codex \
  /var/lib/lrai-agent/.claude \
  /var/lib/lrai-agent/.config
sudo install -d -o root -g lrai-agent -m 0750 /etc/lrai-agent
sudo install -d -o root -g root -m 0755 /opt/lrai-agent/bin
```

Keep the developer checkout separate from these runtime directories.

## 2. Build and install a real package

As the operator, clone the repository and enter it:

```bash
git clone https://github.com/lrai-engineering/lrai-agent.git
cd lrai-agent
npm ci
npm run check
```

The operator's Git authentication is only for this source checkout. Task repository access will use the App.

With a supported Node.js/npm already installed, run from that checkout:

```bash
agent_node=$(command -v node)
agent_npm=$(command -v npm)
sudo install -m 0755 "$agent_node" /opt/lrai-agent/bin/node

agent_package_dir=$(mktemp -d /tmp/lrai-agent-package.XXXXXX)
agent_package_name=$(npm pack --ignore-scripts --pack-destination "$agent_package_dir")
sudo env PATH=/opt/lrai-agent/bin:/usr/bin:/bin \
  "$agent_npm" install --global --prefix /opt/lrai-agent --omit=dev \
  "$agent_package_dir/$agent_package_name"

/opt/lrai-agent/bin/node --version
/opt/lrai-agent/bin/node \
  /opt/lrai-agent/lib/node_modules/@lrai-engineering/lrai-agent/dist/src/index.js --help
```

Keep the tarball for rollback. Do not use `npm link` or a global install of the source directory for the hardened service: that may leave a link into the operator's home instead of a readable installation under `/opt/lrai-agent`.

Implementation and deploy-only runs also need Bubblewrap and an operator-pinned
pnpm toolchain. The current adapter supports pnpm projects with `lint` and `build`
scripts, plus `test` when present. Other stacks require a host-owned adapter and
fail before execution instead of silently skipping validation. For Calify:

```bash
sudo apt-get install bubblewrap
sudo env PATH=/opt/lrai-agent/bin:/usr/bin:/bin \
  "$agent_npm" install --global --prefix /opt/lrai-agent --ignore-scripts \
  npm@11.11.1 pnpm@11.25.0
```

The pnpm version must match the repository's exact `packageManager` value.
`LRAI_WORKER_TOOLCHAIN` selects a host-owned prefix (default `/opt/lrai-agent`);
do not point it at a home directory or any directory containing credentials.
The prefix must be root-owned and immutable to the service user. User namespaces
must be enabled for Bubblewrap. Validation never falls back to unsandboxed runs.

## 3. Install and authenticate the provider CLIs

Install your approved Codex and/or Claude Code release into an operator-managed location available on the service PATH. For npm-distributed releases, the pattern is:

```text
sudo env PATH=/opt/lrai-agent/bin:/usr/bin:/bin <absolute-npm-path> install \
  --global --prefix /opt/lrai-agent <provider-package>@<approved-version>
```

Package names for the existing installation are `@openai/codex` and `@anthropic-ai/claude-code`. Replace the placeholders with versions you have tested. Check each executable under the same environment the service will use:

```bash
sudo -u lrai-agent env HOME=/var/lib/lrai-agent \
  PATH=/usr/bin:/bin:/opt/lrai-agent/bin \
  CODEX_HOME=/var/lib/lrai-agent/.codex \
  /opt/lrai-agent/bin/codex --version

sudo -u lrai-agent env HOME=/var/lib/lrai-agent \
  PATH=/usr/bin:/bin:/opt/lrai-agent/bin \
  /opt/lrai-agent/bin/claude --version
```

For Codex, run the following interactively and complete the browser/device-code approval using the intended subscription account:

```bash
sudo -u lrai-agent env HOME=/var/lib/lrai-agent \
  PATH=/usr/bin:/bin:/opt/lrai-agent/bin \
  CODEX_HOME=/var/lib/lrai-agent/.codex \
  /opt/lrai-agent/bin/codex login --device-auth
```

Device-code login may need enabling in account/workspace settings. The valid command is `codex login --device-auth`, not `codex --login`. See [official OpenAI authentication guidance](https://developers.openai.com/codex/auth).

For Claude, start the CLI as the service user, complete subscription login, and exit after checking `/status`:

```bash
sudo -u lrai-agent env HOME=/var/lib/lrai-agent \
  PATH=/usr/bin:/bin:/opt/lrai-agent/bin \
  /opt/lrai-agent/bin/claude
```

Use the intended Claude subscription login, not an unintended Console/API-key route. Do not set API-key variables in the service environment for this subscription setup. Authenticate the dedicated service-user directories directly; do not copy the operator's personal provider state. See [Claude Code authentication](https://code.claude.com/docs/en/authentication).

## 4. Install the App key and environment file

Replace the source path below with the private key securely downloaded during GitHub setup:

```text
sudo install -o root -g lrai-agent -m 0640 \
  /secure/path/downloaded-app-key.pem /etc/lrai-agent/github-app.pem
```

Create a protected environment file once:

```bash
sudo install -o root -g root -m 0600 /dev/null /etc/lrai-agent/webhook.env
sudoedit /etc/lrai-agent/webhook.env
```

The `install /dev/null` command is for initial creation only: running it again would empty an existing configuration. Enter these fields in the editor, replacing every placeholder:

```dotenv
LRAI_GITHUB_APP_ID=YOUR_NUMERIC_APP_ID
LRAI_GITHUB_PRIVATE_KEY_PATH=/etc/lrai-agent/github-app.pem
LRAI_GITHUB_WEBHOOK_SECRET=YOUR_SHARED_RANDOM_SECRET
LRAI_ALLOWED_SENDERS=YOUR_GITHUB_LOGIN
LRAI_WEBHOOK_SPOOL=/var/lib/lrai-agent/webhook-spool
LRAI_WEBHOOK_HOST=127.0.0.1
LRAI_WEBHOOK_PORT=8095
```

Use comma-separated logins for multiple allowed senders. Both supplied services read this environment file through systemd. It is an environment file, not a shell script; do not add `export`.

## 5. Install the services

From the LRAI Agent checkout:

```bash
sudo install -m 0644 deploy/jetson/lrai-agent-webhook.service \
  /etc/systemd/system/lrai-agent-webhook.service
sudo install -m 0644 deploy/jetson/lrai-agent-worker.service \
  /etc/systemd/system/lrai-agent-worker.service
```

The worker unit shipped in `deploy/jetson` accommodates privileged previews. For a generic host doing only plan/implement work, use `sudo systemctl edit lrai-agent-worker.service` to add this tighter profile:

```ini
[Service]
ProtectHome=true
NoNewPrivileges=true
PrivateDevices=true
```

Do not install the preview sudoers rule or enable the deploy label on that profile. A later preview integration needs its own reviewed host policy; the Jetson deployer cannot work with `NoNewPrivileges=true`.

Start the services:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lrai-agent-webhook.service lrai-agent-worker.service
systemctl is-active lrai-agent-webhook.service lrai-agent-worker.service
curl --fail http://127.0.0.1:8095/healthz
```

Expected local response: `{"status":"ok"}`.

## 6. Make only the receiver publicly reachable

For an already connected Tailscale host with Funnel enabled by its tailnet policy:

```bash
sudo tailscale funnel --bg --https=8443 http://127.0.0.1:8095
tailscale funnel status
tailscale serve status
```

Use the displayed HTTPS hostname plus `:8443/github/webhook` in the App settings. Keep private app routes on their existing Serve port. See [Funnel configuration](https://tailscale.com/docs/features/tailscale-funnel) for the required tailnet policy and HTTPS prerequisites.

With a different HTTPS reverse proxy, forward the request body unchanged to `127.0.0.1:8095`, preserve GitHub headers, and allow the receiver's 10 MiB request limit.

## 7. Verify an actual task

Use `codex-plan` on a small issue in a selected repository. Check delivery acknowledgment, label consumption, the started comment, the final plan, and a `.json.done` archive. A health response alone does not verify App permissions or provider authentication.

Continue with [Configuration and commands](Configuration-and-Commands.md), then [Preview deployments](Preview-Deployments.md) if needed.
