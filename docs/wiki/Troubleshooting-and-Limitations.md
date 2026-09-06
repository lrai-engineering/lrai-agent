# Troubleshooting and current limitations

## Start with the request path

Find the delivery ID in the App's Recent deliveries or the bot's started comment. Then inspect the relevant service, not the entire system journal:

```bash
journalctl -u lrai-agent-webhook.service --since '30 minutes ago' --no-pager
journalctl -u lrai-agent-worker.service --since '30 minutes ago' --no-pager
systemctl status lrai-agent-webhook.service lrai-agent-worker.service --no-pager
curl --fail http://127.0.0.1:8095/healthz
tailscale funnel status
tailscale serve status
```

For preview problems:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}'
docker inspect --format '{{.State.Status}} {{index .Config.Labels "com.lrai-agent.preview.sha"}}' calify-pr-3
curl --fail --max-time 10 http://127.0.0.1:8090/calify-pr-3
curl --fail --max-time 10 https://jetson.tail68fd31.ts.net/calify-pr-3
```

Use the actual PR number. Do not post environment files, keys, OAuth caches, raw task envelopes, or unreviewed full journals in public issues.

## Symptoms, causes, and next checks

| Symptom | Meaning / next check |
| --- | --- |
| `401 invalid signature` | Secret mismatch, missing signature, or proxy altered the request body. Check matching secret configuration without printing it. |
| `400 missing webhook headers` | Direct POST lacked GitHub event/delivery headers; use GET `/healthz` for a basic health check. |
| `202 ignored` | Event/action/label is unsupported or actor fails authorization. Confirm exact spelling and issue author/sender. |
| `202 queued`, no final comment | Check worker service, queue state, App key access, and installation-token errors. The started comment is posted only after label removal and clone/config loading. |
| Label disappeared but task failed | Consumption happens before task success. Inspect failure, then request a new run after correcting the cause. |
| GitHub API 403/404 | Check selected installation repositories, accepted App permissions, branch/ruleset restrictions, and correct PR target. |
| `203/EXEC` or command not found | Verify absolute Node path and service PATH; NVM from an interactive shell is not automatically available to systemd. |
| Config/provider file missing under systemd | Check file permissions and whether npm linked the package into a protected home directory. Use a packed installation. |
| Codex read-only-filesystem initialization error | Confirm writable service state, `CODEX_HOME`, and `ReadWritePaths=/var/lib/lrai-agent`. |
| Provider login fails only in service | Authenticate the dedicated service-user home; verify installed executable and environment match the login environment. |
| `preview.app is required` | Put preview config on the consuming repository's default branch, or check a host `LRAI_CONFIG` override. |
| Preview repository/app not allowlisted | The supplied script supports only Calify's documented target. Implement a new host adapter before using another app. |
| Sudo fails inside the worker | Check the exact root-owned script/rule and unit hardening. `NoNewPrivileges` blocks elevation; `PrivateDevices` can imply it. |
| Ref does not match requested commit | Branch advanced between PR lookup and clone. Request another deployment after the branch stabilizes. |
| No agent implementation PR found | Check the original issue's PR marker, open state, `agent/issue-N-` branch name, and `Closes #N` body. |
| Unknown label does nothing | GitHub label creation is not code registration; deploy both updated receiver and worker. |
| Generic gateway 502 | Check gateway container, port 8090, upstream network/container, and Docker startup before changing Tailscale routes. |
| Old preview loads after a build | Check container SHA, gateway include mount, and Nginx reload/resolution. A valid URL alone does not establish the intended commit. |

## The September 7 preview failure

The old deployer moved its staging checkout, set `staging=`, then exited successfully. Its EXIT cleanup ended with:

```bash
[[ -n "$staging" ]] && rm -rf -- "$staging"
```

The empty-variable test returned 1 under `set -e`, turning successful deployment into exit 1 without an error message. The old worker rethrew that task error out of its main loop, so systemd restarted it.

The fix preserves the original exit status in cleanup, emits structured deployment results, and catches individual task failures in the worker loop. Confirm the installed files contain the fix, not just the Git checkout. Unrelated Tailscale discovery/drop lines are not evidence of this shell failure.

## Current limitations that affect operators

These are implementation facts at the documented baseline, not promised features:

- **Not exactly-once:** intake prevents overwriting an already queued filename. Once the worker renames it to processing/done/failed, another delivery with that ID can create a queued filename again. Distinct opened/labeled events can also represent the same intent. Label consumption alone is not durable deduplication.
- **No automatic recovery:** failed tasks are archived; interrupted processing files are not reclaimed; no retry/backoff or task timeout is implemented. A stuck provider can hold the single worker queue.
- **New implementation branch each run:** there is no automatic continuation of an existing PR or full issue-conversation-driven edit loop.
- **No worker test gate:** the App worker does not run repository validation or enforce the Actions template's protected-file checks before publishing a draft PR. CI and human review remain essential.
- **Limited ingress policy:** the receiver uses signature, command and sender checks, but no explicit repository/installation-ID allowlist beyond the App's installation scope.
- **Shared host/service identity:** temporary workspaces are not disposable VMs. Providers inherit process environment; the worker reads the App private key and the shared environment file. The deploy-capable service has a privileged local path and readable host homes.
- **Trusted preview repositories only:** the root deployer executes Docker Compose from the checked-out repository. Repository/app string checks do not sandbox untrusted Compose definitions or Docker builds.
- **Calify-only preview lifecycle:** no generic adapter registry, automatic PR-close cleanup, image pruning, or deployment dashboard.
- **Snapshot timing:** deployment uses a PR head and discussion snapshot read before it starts; a later push/edit needs another command. Implementation prompts use queued issue title/body.
- **No CI feedback loop:** the App worker currently posts its result; it does not monitor and repair CI failures or merge PRs automatically.

For a trusted personal/team installation, these limits explain the operating procedures in this wiki. Broader multi-tenant or public-repository execution needs a separate hardening design.
