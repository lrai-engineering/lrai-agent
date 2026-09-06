# Updating and operating

## Source publication is not a service update

There are three separate copies to consider:

| Copy | Example | How it changes |
| --- | --- | --- |
| Git source | Operator checkout and GitHub `main` | Commit, push, pull |
| Installed package | `/opt/lrai-agent/lib/node_modules/@lrai-engineering/lrai-agent` | Build, pack, install |
| Running process | systemd receiver and worker | Restart the affected services |

The package version may remain `0.2.0` across source changes. Record the deployed Git commit as part of your deployment notes; `--help` alone does not identify the exact build.

## Choose the right update

| Change | Required update |
| --- | --- |
| New label or comment command | Full package install; restart receiver and worker |
| Worker orchestration or provider adapter | Full package install; restart worker; normally deploy receiver and worker together |
| Packaged prompt or config defaults | Full package install and affected worker restart |
| Repository `.lrai-agent.yml` | Commit to the default branch; new tasks load it |
| Host `webhook.env` | Edit protected file; restart affected services |
| systemd unit | Install unit, `daemon-reload`, restart service |
| Preview script/result contract | Update worker and root-owned deployer together |
| Documentation only | Publish repository docs/wiki; no service restart |

## General package update

First pause new commands and let active tasks finish. Inspect queue filenames without dumping issue content or credentials:

```bash
sudo find /var/lib/lrai-agent/webhook-spool -maxdepth 1 -type f \
  \( -name '*.json' -o -name '*.processing' \) -printf '%f\n'
```

Do not interrupt a deployment/build merely because it has been quiet. Check the relevant journal before stopping services.

In a clean operator checkout:

```bash
git pull --ff-only
npm ci
npm run check
node dist/src/index.js plan --dry-run --repository owner/repo \
  --issue-number 1 --title 'Installation check' --body 'Inspect only'
node dist/src/index.js implement --dry-run --repository owner/repo \
  --issue-number 1 --title 'Installation check' --body 'Prepare a small change'
```

If `git pull --ff-only` cannot proceed, resolve the local changes/divergence without discarding work. Keep the previous tested package tarball and configuration for rollback.

Package and install the new code as in [VM setup](VM-Setup.md), omitting its one-time account/key/file creation. For a coordinated receiver/worker upgrade:

```bash
agent_npm=$(command -v npm)
agent_package_dir=$(mktemp -d /tmp/lrai-agent-package.XXXXXX)
agent_package_name=$(npm pack --ignore-scripts --pack-destination "$agent_package_dir")

sudo systemctl stop lrai-agent-webhook.service lrai-agent-worker.service
sudo env PATH=/opt/lrai-agent/bin:/usr/bin:/bin \
  "$agent_npm" install --global --prefix /opt/lrai-agent --omit=dev \
  "$agent_package_dir/$agent_package_name"
```

If the deployment contract changed, install the matching root-owned script before restarting:

```bash
sudo install -m 0755 deploy/jetson/lrai-agent-preview-deploy.sh \
  /usr/local/sbin/lrai-agent-preview-deploy
```

Install changed unit files only after reviewing their effect on your host/profile, then run `sudo systemctl daemon-reload`. Start and verify:

```bash
sudo systemctl start lrai-agent-webhook.service lrai-agent-worker.service
systemctl is-active lrai-agent-webhook.service lrai-agent-worker.service
curl --fail http://127.0.0.1:8095/healthz
journalctl -u lrai-agent-worker.service -n 40 --no-pager
```

During receiver downtime, deliveries can fail. Inspect GitHub Recent deliveries afterward; do not assume failed deliveries were retried or safely deduplicated.

## Narrow preview-worker patch

For the specific preview cleanup/reuse fix, an existing installation can use:

```bash
npm run check
sudo bash deploy/jetson/update-preview-worker.sh
```

It checks for pending/processing tasks, backs up the installed worker module and deployer under `/opt/lrai-agent/preview-worker-backup.*`, replaces both, and restarts only the worker. It attempts rollback if an installation step fails. This is not a general package updater: it does not update `webhook.js`, other modules, dependencies, or units. Do not use it to deploy new label recognition.

The broader `install-preview-deployer.sh` is Jetson-specific and also restarts the gateway boot service; use it when that full integration is intended.

## Verify behavior after an update

1. Confirm the services are active and local `/healthz` succeeds.
2. Compare relevant installed files with the just-built files or retained package.
3. Run a `codex-plan` smoke test in a selected test repository.
4. If preview behavior changed, request `deploy` on a known agent PR; verify the exact commit and both local/private routes.
5. Request `deploy` again without content changes; expect the no-redeploy URL result.
6. For a new command, test its positive and ignored/unauthorized cases before regular use.

A local test suite does not validate provider OAuth, App installation scope, Docker health, or the deployed service copy.

## Queue operations and recovery

| Filename | Meaning |
| --- | --- |
| `<delivery>.json` | Queued |
| `<delivery>.json.processing` | Claimed by worker |
| `<delivery>.json.done` | Completed |
| `<delivery>.json.failed` | Failed task; daemon continues |

There is no automatic retry, dead-letter dashboard, or stale-processing recovery. `worker --once` processes one observed batch and exits nonzero if a task failed; do not run it alongside the service against the same live queue.

A leftover processing file may mean the process died after external actions already occurred. Inspect the issue, PR, container, and journal before deciding how to recover. Do not blindly rename all processing/failed files back to queued files. For a reviewed failed task, a new authorized command is usually easier to trace than replaying its old envelope.

## Rollback

Reinstall the exact previous package tarball, matching deployer and units if their contract changed, then restart the affected services. Preserve provider state, App keys, and spool archives. The narrow patch script's backup is sufficient only for its two replaced files.

## Maintaining this wiki

Edit the canonical Markdown and diagrams in `docs/wiki/`, review them alongside code changes, and run `node scripts/check-wiki.mjs`. Render changed PlantUML sources using [Diagrams](Diagrams.md).

Prepare a clean clone of the separate wiki repository, then run:

```bash
node scripts/sync-wiki.mjs /absolute/path/to/lrai-agent.wiki
git -C /absolute/path/to/lrai-agent.wiki diff --check
git -C /absolute/path/to/lrai-agent.wiki diff --stat
```

The sync command copies this project's pages/assets, converts local page links for GitHub Wiki, and preserves other wiki files. It does not commit or push. Review and commit the source change to the main repository and the rendered copy to the wiki's existing branch; do not force-push.

GitHub requires an initial page created through the web UI before a wiki can be cloned. See [GitHub wiki editing](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages).
