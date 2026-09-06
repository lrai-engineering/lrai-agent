# GitHub setup

## 1. Register the App

In your account or organization settings, open **Developer settings → GitHub Apps → New GitHub App**. Set a descriptive name and homepage URL. Enable webhooks and use the HTTPS address that will forward to the receiver's `/github/webhook` path.

For the existing Jetson deployment the URL is:

```text
https://jetson.tail68fd31.ts.net:8443/github/webhook
```

For another host, use its actual public endpoint. A private tailnet-only URL is not sufficient for GitHub delivery.

Create a strong random webhook secret with your password manager or an interactive `openssl rand -hex 32` invocation. Store the same value in the App settings and the host's protected environment file. Keep TLS certificate verification enabled. This workflow does not require an OAuth callback or a GitHub App client secret.

GitHub's [App registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) describes the UI.

## 2. Grant the repository permissions used by this worker

| Permission | Access | Reason in this implementation |
| --- | --- | --- |
| Metadata | Read | Repository identity |
| Contents | Read and write | Clone source and push implementation branches |
| Issues | Read and write | Read issue context, remove command labels, post results |
| Pull requests | Read and write | Read PR heads/reviews and create draft PRs |

Subscribe to **Issues** and **Issue comment** events. These correspond to `issues` and `issue_comment` in the receiver. Adding a command label later does not require a new event subscription.

Request additional permissions only for separately designed features. Changes to App permissions may require installation-owner acceptance. See [choosing App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

## 3. Install on selected repositories

Open the App's **Install App** page, select the owning account/organization, and select the consuming repositories. Confirm the intended repository is included. The App's own source repository and a consuming app are separate choices.

Record the numeric **App ID** for `LRAI_GITHUB_APP_ID`. Generate and securely download an App private key. The worker reads its path from `LRAI_GITHUB_PRIVATE_KEY_PATH`; the installation ID arrives in each webhook payload and is used to request an installation token.

A GitHub App token and `GITHUB_TOKEN` from GitHub Actions are different authorization paths. The Actions option allowing workflows to create PRs belongs to the Actions template, not the App-token worker.

## 4. Create command labels

Create these exact names in each consuming repository:

| Label | Purpose |
| --- | --- |
| `codex-plan` | Read-only Codex plan |
| `claude-plan` | Read-only Claude plan |
| `codex` | Codex implementation and new draft PR |
| `claude` | Claude implementation and new draft PR |
| `deploy` | Preview the linked implementation PR |

Descriptions and colors are cosmetic; recognition uses the label name. Enable `deploy` only for repositories whose host-side preview policy has been implemented.

## 5. Configure the repository and verify delivery

Commit the repository configuration described in [Configuration and commands](Configuration-and-Commands.md), then complete [VM setup](VM-Setup.md).

Create a small issue as the approved user, then add `codex-plan`. In the App's **Advanced → Recent deliveries**, check the event, response, and delivery ID. Expect `202 queued` from an authorized task and then bot comments on the issue. A ping event is not a provider smoke test.

Use an existing task's delivery ID to correlate the GitHub request with the host journal and spool files. See [Troubleshooting](Troubleshooting-and-Limitations.md) before redelivering: the current queue does not guarantee exactly-once execution after a task has been claimed or archived.
