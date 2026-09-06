# Configuration and commands

## Configure the consuming repository

Commit a `.lrai-agent.yml` file in the target repository's default branch:

```yaml
version: 1
provider: codex
```

For the existing Calify preview contract:

```yaml
version: 1
provider: codex
preview:
  app: calify
```

The worker initially clones the default branch and loads this configuration before resolving an implementation PR. A configuration change present only on the PR branch will not configure that deploy-only task.

| Setting | Default or behavior |
| --- | --- |
| `version` | `1` |
| `provider` | `codex`; command labels select their explicit provider |
| `providers.codex.model` | Omitted: provider CLI default |
| `providers.claude.model` | Omitted: provider CLI default |
| `plan.prompt` | Packaged `prompts/plan.md` |
| `implement.prompt` | Packaged `prompts/implement.md` |
| `preview.app` | No default; required for deployment, lowercase URL-safe name |
| `providers.*.executable` | Host policy only; rejected in repository configuration |

An explicitly configured prompt path is resolved relative to its configuration file. Prompt templates support `{{repository}}`, `{{issueReference}}`, `{{sender}}`, `{{title}}`, and `{{body}}`.

`LRAI_CONFIG=/absolute/path/config.yml` selects a complete host-owned configuration instead of the repository file; the two files are not layered. Only this explicit configuration can override provider executables. Setting it globally can also override the repository's preview identity or model/prompt choices.

## Command reference

| Issue label or comment command | Result |
| --- | --- |
| `codex-plan` | Read-only Codex plan posted to the issue |
| `claude-plan` | Read-only Claude plan posted to the issue |
| `codex` | Codex edits, worker commits a new branch and opens a draft PR |
| `claude` | Claude edits, worker commits a new branch and opens a draft PR |
| `deploy` | Resolve the latest linked open agent PR and request its preview |

A comment can request a command with a line such as:

```text
/lrai-agent codex-plan
```

Commands are case-sensitive. The receiver accepts these lines only on newly created issue comments by an allowed sender. Editing an old comment or editing an issue body does not itself launch a task.

For label-driven issue events, the approved actor must also be the issue author. Ordinary unrelated labels are ignored.

## Combining labels

The event matters, not just the final collection of labels.

| Event | Current behavior |
| --- | --- |
| Issue opened with one provider command | Queue that command |
| Issue opened with `codex` and `deploy` | Implement, then preview the new PR |
| Provider implementation label added while `deploy` is present | Implement, then deploy |
| `deploy` label added to an existing issue | Deploy-only, even if a provider label is present |
| Multiple provider-command labels on an issue | Provider task is not selected |
| Planning label with `deploy` | Plan only; label-based selection also consumes `deploy` |

For predictable combined implementation/deployment, create the issue with both labels in one operation. For an existing implementation PR, add `deploy` by itself. Adding a provider label and then `deploy` as separate events can queue separate tasks.

The worker consumes the labels recorded in the accepted task. Removing a label afterward does not cancel a task already queued. Comment commands have no labels to consume.

## What is and is not updated

An implementation run starts from the freshly cloned repository and creates `agent/issue-<issue>-<delivery-prefix>`. It currently does not resume the prior issue branch or update an existing draft PR.

Deploy-only resolves a PR from the issue's `<!-- lrai-agent-pr:N -->` marker, with a legacy draft-PR-link fallback. It reads that PR's current head SHA, so manually pushing additional commits to the same linked branch is supported for deployment.

Editing the issue can invalidate preview reuse, but `deploy` does not implement the revised instructions. Use a provider implementation command when source code needs to change.

## Attachments

The issue body can contain supported GitHub-hosted image, PDF, text, source, and data attachments. Downloads are limited to eight files, 10 MiB per file, 30 MiB total, and allowlisted hosts/redirects. Codex images are passed with `--image`; attachment paths are also included in the prompt.

Files are temporary task context, not shell instructions. Unsupported/inaccessible selected attachments fail the task. The full issue conversation is not automatically loaded as the implementation prompt: implementation uses the queued title/body and attachment context. Deployment fingerprinting separately reads live discussion.

## Environment settings

| Variable | Used by |
| --- | --- |
| `LRAI_GITHUB_WEBHOOK_SECRET` | Receiver HMAC verification |
| `LRAI_ALLOWED_SENDERS` | Receiver's comma-separated actor allowlist |
| `LRAI_WEBHOOK_HOST`, `LRAI_WEBHOOK_PORT` | Receiver bind address, defaults 127.0.0.1:8095 |
| `LRAI_WEBHOOK_SPOOL` | Shared receiver/worker queue path |
| `LRAI_GITHUB_APP_ID`, `LRAI_GITHUB_PRIVATE_KEY_PATH` | Worker installation-token creation |
| `LRAI_CONFIG` | Optional complete host-owned configuration |
| `LRAI_PREVIEW_DEPLOY_COMMAND` | JSON command array for trusted deployer |
| `LRAI_PREVIEW_DEPLOY_EXECUTABLE` | Single executable fallback when command array is unset |
| `CODEX_HOME`, `HOME`, `XDG_CONFIG_HOME` | Service-local provider state |
| `LRAI_GITHUB_TOKEN` | Set only for the spawned preview command, not a value to store manually |

Source: [configuration parser](https://github.com/lrai-engineering/lrai-agent/blob/main/src/config.ts), [command selection](https://github.com/lrai-engineering/lrai-agent/blob/main/src/webhook.ts), [worker](https://github.com/lrai-engineering/lrai-agent/blob/main/src/worker.ts).
