# LRAI Agent

Portable orchestration for running coding agents from GitHub Actions, a
self-hosted runner, or a developer workstation.

`lrai-agent` owns the versioned agent behavior: task parsing, prompts,
provider selection, and (over time) validation and delivery workflows. It does
not own the GitHub Actions runner installation and it does not store machine
credentials.

## Status

This repository is at the v0.1 foundation stage. The first command is a
read-only planning command that can invoke either Codex or Claude Code:

```text
GitHub issue / local task
          |
          v
    lrai-agent plan
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

Only the worker needs this installation. Consuming repositories call the
worker's command; they do not copy this source tree. Once a version tag exists,
another worker can install that exact release directly from the private Git
repository:

```bash
npm install --global \
  'git+ssh://git@github.com/lrai-engineering/lrai-agent.git#v0.1.0'
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
[`config/agents.yml`](config/agents.yml) for all v0.1 worker settings.

## Thin GitHub Actions trigger

A consuming repository only needs to pass the task context to the installed
CLI. [`templates/github/agent-plan.yml`](templates/github/agent-plan.yml) is a
starting point for a self-hosted worker.

Keep authorization gates in the workflow. Issue titles and bodies are
untrusted input, and a workflow must decide which actors and labels are allowed
to start an agent before invoking this program.

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
- v0.2: prompt and repository policy improvements
- v0.3: implementation and review commands
- v0.4: isolated worktrees
- v0.5: branch creation
- v0.6: pull request publication
- v0.7: CI feedback loop
- v0.8: bounded retries
- v1.0: GitHub App webhook/orchestrator

Mutation and publication features will require explicit repository policy;
they will not be implicit side effects of `plan`.
