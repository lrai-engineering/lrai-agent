# VM setup

These are operator-run instructions for a Linux/systemd host. Complete [Prerequisites](Prerequisites.md) first. The portable worker setup below does not install a GitHub Actions runner.

## Ubuntu EC2 demo walkthrough

The initial setup below was exercised on an Ubuntu x86_64 EC2 micro instance
with 1 GiB RAM and approximately 3.5 GB free disk. This records initial setup,
not a validated capacity recommendation: an agent implementation and preview
build have not yet been tested on that instance. Check `free -h` and `df -h /`
before larger builds; resize if memory or disk becomes a bottleneck.

### Checkpoint: what is working

| Component | Verified progress |
| --- | --- |
| Host tools | Node.js, npm, Git, Docker, and Nginx reported installed |
| Agent runtime | Initial installer completed; dedicated `lrai-agent` user and runtime directories created |
| Provider | Codex CLI 0.160.0 installed; device-code login completed as `lrai-agent` |
| Nginx | Configuration test passed; localhost and an external HTTP request returned 200 |
| EC2 networking | Public IPv4 assigned; inbound HTTP/HTTPS rules added; outbound access enabled |
| Certificate tooling | Certbot 5.8 installed; certificate issuance and Nginx TLS configuration not yet confirmed |

Still to configure and verify: the demo GitHub App and its installation,
App key and webhook environment, webhook/worker services, the Nginx webhook
proxy route, and a real issue-to-PR run. Bubblewrap execution and the consuming
repository's pinned package manager must be checked before implementation.
Preview deployment also needs a VM-specific adapter; the Jetson deployment
script is not a generic Nginx installer.

### 1. Prepare the host and network

Use the instance's **public IPv4 address**, not its private `172.31.x.x` address.
The subnet needs a route to an Internet Gateway. For this single-host demo, use
these security-group rules:

| Direction | Traffic | Source or destination |
| --- | --- | --- |
| Inbound | SSH, TCP 22 | Your administration IP address |
| Inbound | HTTP, TCP 80 | `0.0.0.0/0` |
| Inbound | HTTPS, TCP 443 | `0.0.0.0/0` |
| Outbound | All traffic | `0.0.0.0/0` |

Outbound access is needed for package downloads, GitHub, and the provider.
An empty outbound rule list blocks new outbound connections; responses to
allowed inbound connections are automatically permitted by security groups.
See [AWS security-group guidance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-rules-reference.html).
Keep the receiver's port 8095 and preview container ports internal.

With Node.js 22+, npm, Git, and sudo already available, install the remaining
basic tools if needed:

```bash
sudo apt-get update
sudo apt-get install -y curl ca-certificates xz-utils unzip jq nginx bubblewrap
```

Docker is for container previews, not a requirement for the receiver alone.

### 2. Install the runtime and log in to Codex

Use the **Initial runtime installer** section below. Run it as the Ubuntu login
user with `bash scripts/install-runtime.sh`; executable permission is not needed
when invoking the file through Bash. It does not install provider CLIs.

Only one provider is needed for this demo. The following pins the Codex version
used during setup. Commands are single lines to simplify pasting through tmux:

```bash
sudo env PATH=/opt/lrai-agent/bin:/usr/bin:/bin "$(command -v npm)" install --global --prefix /opt/lrai-agent @openai/codex@0.160.0
/opt/lrai-agent/bin/codex --version
sudo -u lrai-agent env HOME=/var/lib/lrai-agent CODEX_HOME=/var/lib/lrai-agent/.codex PATH=/opt/lrai-agent/bin:/usr/bin:/bin /opt/lrai-agent/bin/codex login --device-auth
```

Open the displayed login link on your own computer and complete device-code
approval there. Authenticate as the service user so the worker can use the
login; `/var/lib/lrai-agent` is its home directory, not a command to execute.
Do not copy another machine's credentials or share login codes. See
[OpenAI authentication guidance](https://developers.openai.com/codex/auth).

Verify the login separately:

```bash
sudo -u lrai-agent env HOME=/var/lib/lrai-agent CODEX_HOME=/var/lib/lrai-agent/.codex PATH=/opt/lrai-agent/bin:/usr/bin:/bin /opt/lrai-agent/bin/codex login status
```

### 3. Verify public HTTP before configuring HTTPS

```bash
sudo nginx -t
curl -I http://127.0.0.1
```

Expect a successful configuration test and HTTP 200. Then open
`http://YOUR_PUBLIC_IP/` from another machine, explicitly using **http**. A
successful local request alone does not prove public access. If the public
request fails, first check the security group attached to this instance and its
inbound TCP 80 rule. Adding that rule does not require restarting Nginx.

The welcome page proves only that Nginx is reachable. It does not mean
`/github/webhook` is routed to the receiver. Likewise, allowing TCP 443 in the
security group does not configure an HTTPS listener or certificate.

### 4. Certificate tooling checkpoint

Certbot was installed with:

```bash
sudo snap install --classic certbot
/snap/bin/certbot --version
```

The observed version was 5.8. Let's Encrypt supports IP-address certificates;
Certbot 5.4+ supports obtaining them with webroot verification. These certificates
last six days and need automatic renewal plus an Nginx reload hook. See
[Let's Encrypt's IP certificate instructions](https://letsencrypt.org/2026/03/11/shorter-certs-certbot).
Certificate issuance, renewal testing, and HTTPS activation remain pending in
this walkthrough; installing Certbot alone does not enable HTTPS.

Certbot is a hosting tool, not an LRAI Agent dependency. GitHub can deliver
webhooks over HTTP, though [GitHub recommends HTTPS](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
A temporary HTTP demo can test issue-to-PR behavior after the receiver and proxy
are configured, using non-sensitive demo content. Keep signature verification
enabled; signatures authenticate payloads but do not encrypt them. The current
worker requires HTTPS URLs for preview deployment results.

### Troubleshooting encountered during setup

**Sudo asks for a password even though no password was set.** Test
`sudo -n true`. If it succeeds but `sudo -n -v` requires interactive
authentication, command execution and timestamp validation have different sudo
policies. The updated installer checks `sudo true`, not `sudo -v`. Pull the
latest code and retry; setting a root password or running `chmod` is not the fix.

**Commands appear to produce no output.** Directory creation with `install -d`
normally succeeds silently, but `id` and `node --version` should print output.
In this setup, stdout was not reaching the terminal while stderr still worked.
Diagnose this in the interactive shell:

```bash
printf 'STDOUT TEST\n'
printf 'STDERR TEST\n' >&2
/usr/bin/id lrai-agent 1>&2
```

If only stderr is visible, restore stdout to the current terminal and retest:

```bash
exec 1>/dev/tty
printf 'Output is back!\n'
```

This changes the current shell's output routing. If neither stream is visible,
try a fresh SSH connection outside tmux. Do not repeatedly reinstall packages
just because output is missing.

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
