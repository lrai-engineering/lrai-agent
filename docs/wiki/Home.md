# LRAI Agent operator and developer wiki

LRAI Agent turns an authorized GitHub issue command into a Codex or Claude Code task. The GitHub App worker runs on a Linux machine, publishes plans or draft pull requests, and can request a private preview through a separately configured deployer.

This guide describes the implementation at [0908cb5](https://github.com/lrai-engineering/lrai-agent/tree/0908cb5308a8a967579320b64d5fafc0d0d123c9), checked on 2026-09-07. Examples that name Jetson or Calify describe that installation, not portable defaults.

## Start here

| Your goal | Read |
| --- | --- |
| Understand the components and trust boundaries | [Architecture](Architecture.md) |
| Check accounts, software, and network requirements | [Prerequisites](Prerequisites.md) |
| Register and install the GitHub App | [GitHub setup](GitHub-Setup.md) |
| Set up a Linux VM or Jetson worker | [VM setup](VM-Setup.md) |
| Configure a consuming repository and use commands | [Configuration and commands](Configuration-and-Commands.md) |
| Understand deploy and preview reuse | [Preview deployments](Preview-Deployments.md) |
| Install updates, verify them, and recover | [Updating and operating](Updating-and-Operating.md) |
| Teach the agent a new issue label | [Adding command labels](Adding-Command-Labels.md) |
| Diagnose failures and understand current gaps | [Troubleshooting and limitations](Troubleshooting-and-Limitations.md) |
| Edit the architecture diagrams | [Diagrams](Diagrams.md) |

For a first installation, follow prerequisites → GitHub setup → VM setup → repository configuration → a `codex-plan` smoke test. Enable implementation and deployment only after the planning path works.

## What a user does

1. Create an issue in a repository selected in the GitHub App installation.
2. Describe the task and attach relevant GitHub-hosted files.
3. Apply `codex-plan` or `claude-plan` to request a plan.
4. Apply `codex` or `claude` to request implementation and a draft PR.
5. For a configured preview target, apply `deploy` to the original issue.
6. Read the bot's result, review the PR, and open the returned private URL from a device on the tailnet.

Creating a label does not give it executable behavior. The receiver and worker recognize a fixed set of commands in code.

## Source of truth

The source for these pages lives in [docs/wiki](https://github.com/lrai-engineering/lrai-agent/tree/main/docs/wiki). Runtime behavior lives in [src](https://github.com/lrai-engineering/lrai-agent/tree/main/src); service units and Jetson deployment policy live in [deploy/jetson](https://github.com/lrai-engineering/lrai-agent/tree/main/deploy/jetson). A Git push updates source control; it does not replace the installed service package.
