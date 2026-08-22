# LRAI Agent

Portable orchestration for running coding agents from GitHub Actions, a
self-hosted runner, or a developer workstation.

`lrai-agent` owns the versioned agent behavior: task parsing, prompts,
provider selection, and (over time) validation and delivery workflows. It does
not own the GitHub Actions runner installation and it does not store machine
credentials.

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
Repository configuration can choose the provider, model, or a repository-owned
prompt. Provider executable paths are worker policy and are only accepted from
the explicit `LRAI_CONFIG` file. See
[`config/agents.yml`](config/agents.yml) for all v0.2 worker settings.

## Phone-friendly GitHub issue workflow

A consuming repository can copy
[`templates/github/agent-issue.yml`](templates/github/agent-issue.yml), replace
the approved GitHub login, and customize its validation step. Create the issue
with exactly one automation label, or add exactly one afterward:

- `codex` or `claude`: implement the issue
- `codex-plan` or `claude-plan`: produce a read-only plan

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
