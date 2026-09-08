# LRAI Agent

Portable orchestration for running coding agents from GitHub Actions, a
self-hosted runner, or a developer workstation.

`lrai-agent` owns the versioned agent behavior: task parsing, prompts,
provider selection, and (over time) validation and delivery workflows. It does
not own the GitHub Actions runner installation and it does not store machine
credentials.

## Documentation

Start with the [LRAI Agent wiki](https://github.com/lrai-engineering/lrai-agent/wiki)
for architecture diagrams, prerequisites, GitHub App and VM setup, command
configuration, preview deployment, updates, and adding new issue labels.
The reviewable [wiki source](docs/wiki/Home.md) is maintained with this codebase.

## Status

The CLI supports two deliberately separate commands with either Codex or
Claude Code:

```text
GitHub issue / local task
          |
          v
    lrai-agent plan / implement
          |
          +-- Codex CLI
          `-- Claude Code
```

## Requirements

- Node.js 22 or newer
- Codex CLI or Claude Code installed and authenticated on the worker
- A Git checkout to inspect

Authentication remains machine-local (`~/.codex`, `~/.claude`, a secret
manager, or short-lived CI credentials). Never commit credentials to this
repository or to a consuming repository.

## Development

```bash
npm ci
npm run check
npm link
```

After `npm link`, the command is available as `lrai-agent`:

```bash
ISSUE_NUMBER=42 \
ISSUE_TITLE="Add an audit log" \
ISSUE_BODY="Record administrative changes." \
REPOSITORY="lrai-engineering/example" \
lrai-agent plan
```

`plan` is read-only. `implement` may edit the checked-out workspace but cannot
publish anything; the authorized GitHub workflow owns validation, git, issue
comments, and draft pull-request creation.

Only the worker needs this installation. Consuming repositories call the
worker's command; they do not copy this source tree. Once a version tag exists,
another worker can install that exact release directly from the private Git
repository:

```bash
npm install --global \
  'git+ssh://git@github.com/lrai-engineering/lrai-agent.git#v0.2.0'
```

Use `--dry-run` to verify the selected provider and rendered prompt without
starting an agent:

```bash
lrai-agent plan \
  --issue-number 42 \
  --title "Add an audit log" \
  --body "Record administrative changes." \
  --repository "lrai-engineering/example" \
  --dry-run
```

Select Claude for one run with `--provider claude`, or configure it for a
repository in `.lrai-agent.yml`:

```yaml
version: 1
provider: claude
```

Configuration is discovered from `.lrai-agent.yml` in the target repository.
Codex defaults to `gpt-6-astra` with `medium` reasoning for both planning and
implementation. Override these with `providers.codex.model` and
`providers.codex.reasoningEffort`; the worker passes them explicitly because
Codex runs with `--ignore-user-config`. Model names in issue prose do not select
the model, and model-selection labels are not currently supported.
Repository configuration can choose the provider, model, or a repository-owned
prompt. Provider executable paths are worker policy and are only accepted from
the explicit `LRAI_CONFIG` file. See
[`config/agents.yml`](config/agents.yml) for all v0.2 worker settings.

## Phone-friendly GitHub issue workflow

GitHub worker implementation runs prepare pnpm dependencies before invoking the
agent, refresh lockfiles afterward, and require sandboxed lint/test/build checks
before preview deployment. One automatic repair attempt is allowed; a remaining
failure preserves the draft PR and skips deployment. The worker requires an
operator-installed pnpm version matching the project and Bubblewrap; see the
[VM setup](docs/wiki/VM-Setup.md). Other package managers need an explicit worker
adapter. Local CLI commands retain their existing bounded behavior.

A consuming repository can copy
[`templates/github/agent-issue.yml`](templates/github/agent-issue.yml), replace
the approved GitHub login, and customize its validation step. Create the issue
with exactly one agent label, or add one afterward:

- `codex` or `claude`: implement the issue
- `codex-plan` or `claude-plan`: produce a read-only plan
- `deploy`: deploy the latest implementation PR for the issue to its configured
  private preview

Combining `codex` or `claude` with `deploy` implements the issue and deploys
the resulting PR preview. Adding `deploy` later runs deployment only; it does
not repeat implementation. `deploy` is consumed when claimed, so it can be
added again for an intentional retry. These deployment-aware semantics apply
to the GitHub App webhook worker; the reusable GitHub Actions template still
requires an explicit repository deployment step.

Repeating `deploy` reuses a healthy preview only when its exact PR head commit
and issue/PR content match the last verified deployment. Content includes
titles, bodies, human comments, and review discussion; bot comments and label
timestamps are excluded. New commits on the same branch or changed content
trigger deployment. A reused preview receives a “Nothing changed; no redeploy
needed” comment with its URL and commit. Both the local gateway and private
HTTPS URL must pass health checks. Existing previews without a saved content
fingerprint deploy once to establish that baseline. Editing an issue does not
implement its instructions: `deploy` still deploys the current PR code.

Deployment commands receive `--context-sha` (SHA-256 of that content) alongside
the repository, PR number, ref, commit SHA, and app. On success they must print
one JSON result: `{"status":"deployed","url":"https://..."}` or
`{"status":"unchanged","url":"https://..."}`. Diagnostics go to stderr.
Failed tasks are archived as `.json.failed`; the daemon logs the error and
continues processing. `worker --once` processes its batch and exits nonzero if
any task failed.

To apply this fix to an existing Jetson installation after `npm run check`, run
`sudo bash deploy/jetson/update-preview-worker.sh`. This backs up and replaces
the worker module and deployer together, then restarts only the worker. Let
active/queued tasks finish first.

The workflow removes the automation label when it claims the run; add it again
to rerun. Adding unrelated labels does not retrigger the agent, and issues with
more than one automation label do not run until the labels are made
unambiguous. Consuming the label also prevents a create-with-label event pair
from starting duplicate work.

Planning posts the result back to the issue. Implementation produces a bounded
workspace patch, runs repository validation, and opens a draft pull request for
manual review. It also retains a credential-free patch artifact for seven days.
It does not merge or deploy. Draft-PR publication requires the repository's
GitHub Actions setting that permits `GITHUB_TOKEN` to create pull requests.

GitHub-hosted images, PDFs, text, source, and data files linked in the issue
body are downloaded into a temporary workspace directory. Downloads are
restricted to GitHub attachment hosts, at most eight files, 10 MiB per file,
and 30 MiB total. Codex receives images through its image-input flag; both
providers receive the attachment paths as untrusted task context. The temporary
directory is removed before validation, patch creation, or publication. An
unsupported or inaccessible attachment fails the run instead of silently
discarding context.

Keep authorization gates in the workflow. Issue titles, bodies, and attachments
are untrusted input, and a workflow must decide which actors and labels are
allowed to start an agent before invoking this program.

## GitHub App webhook receiver

The package also contains the small, signature-verifying ingress service used
by the Jetson worker. It listens on localhost by default and only spools
authorized, explicitly labeled issue tasks; it does not execute providers.
Webhook envelopes are limited to 10 MiB. Issue attachments remain limited to
8 files, 10 MiB per file, and 30 MiB total.

```bash
LRAI_GITHUB_WEBHOOK_SECRET='a-random-secret-at-least-32-characters' \
LRAI_ALLOWED_SENDERS=lukasijus \
LRAI_WEBHOOK_SPOOL=/var/lib/lrai-agent/webhook-spool \
lrai-agent webhook
```

For the Jetson, expose only port `8443` through Tailscale Funnel and forward it
to the receiver's `127.0.0.1:8095`. Keep the existing private Tailscale Serve
gateway on port 443 unchanged. The expected App URL is:

```text
https://jetson.tail68fd31.ts.net:8443/github/webhook
```

The receiver is an ingress boundary, not the task worker. A subsequent worker
must claim spool files idempotently and execute each task in an isolated
workspace.

The worker can be started with `lrai-agent worker`. It consumes queued tasks,
uses a short-lived GitHub App installation token, clones into a private
temporary workspace, downloads issue attachments, runs the selected provider,
and posts the result or failure back to the issue. Preview deployment is an
explicit worker policy step: the repository supplies only a safe preview app
name, while the worker's `LRAI_PREVIEW_DEPLOY_COMMAND` selects an allowlisted
deployment manager and receives the exact PR ref and commit as arguments. On
the Jetson installation, it points to the root-owned, sudo-allowlisted
deployer; the short-lived GitHub token is passed only to that local process and
must never be logged.

Install the current Jetson deployer after publishing the worker and gateway
changes:

```bash
sudo bash deploy/jetson/install-preview-deployer.sh
```

## Ownership boundary

Version controlled here:

- CLI and provider adapters
- prompts and task contracts
- configuration schema and defaults
- tests and reusable workflow templates

Machine or service state, never committed here:

- GitHub runner files (`run.sh`, `bin/`, `externals/`, `_work/`)
- GitHub App private keys and installation tokens
- Codex and Claude credentials
- AWS credentials and runner registration tokens

## Roadmap

- v0.1: provider-neutral planning invocation
- v0.2: bounded planning and implementation commands
- v0.3: review commands and richer repository policy
- v0.4: isolated worktrees
- v0.5: branch creation
- v0.6: pull request publication
- v0.7: CI feedback loop
- v0.8: bounded retries
- v1.0: GitHub App webhook/orchestrator

Mutation and publication features will require explicit repository policy;
they will not be implicit side effects of `plan`.

Implementation and planning jobs refresh the issue body and include human issue
comments when execution starts, so follow-up scope corrections reach the model.
Bot comments are excluded. Discussion is task context only and cannot grant
command or deployment authorization.
