# Prerequisites

## Accounts and access

- A GitHub account/organization that can register an App and install it on the consuming repositories.
- An approved operator login to put in `LRAI_ALLOWED_SENDERS`.
- A Codex/ChatGPT or Claude Code account suitable for the provider workflow you will use. This installation uses provider CLI subscription login under a dedicated Linux service user.
- Git access to the LRAI Agent source for the operator who builds and installs it.
- Sudo access on the worker host.
- For the documented private previews: a Tailscale tailnet, a connected host, and authorized browser devices on that tailnet.

The GitHub App private key, webhook secret, and provider OAuth login serve different purposes. None belongs in a consuming repository.

## Host software

| Requirement | Used by |
| --- | --- |
| Linux with systemd | Supplied service units |
| Node.js 22+ and npm; CI uses Node 24 | Build and run LRAI Agent |
| Git, CA certificates, outbound HTTPS | Clone repositories and call GitHub/provider endpoints |
| Codex CLI and/or Claude Code | Run the selected provider |
| curl | Receiver and preview health checks |
| Tailscale or your own HTTPS reverse proxy | Receive public GitHub webhooks |
| Docker Engine, Compose with `!reset` support, Bash, flock | Jetson preview deployer only |

There is no project-defined minimum RAM or disk budget. Size the host for the repository's dependencies, Docker builds, images, and provider processes. A small receiver is not representative of a Next.js preview build's resource needs.

Pin provider versions approved for your host and confirm they support the flags in `src/providers.ts`. A successful TypeScript build does not establish CLI-version compatibility.

## Network paths

| Connection | Purpose |
| --- | --- |
| GitHub → public HTTPS webhook endpoint | Issue/comment delivery |
| Host → GitHub API and Git endpoints over HTTPS | Installation token, clone, push, comments, PRs |
| Host → provider services over HTTPS | Subscription-backed agent execution |
| Host → GitHub attachment hosts | Download bounded issue context |
| Tailnet browser → private HTTPS preview | View deployed application |

The Jetson example reserves public Funnel port `8443` for the receiver and private Serve port `443` for applications. Tailscale exposes Funnel only on supported ports and a port cannot simultaneously be private Serve and public Funnel. See [Tailscale Funnel documentation](https://tailscale.com/docs/features/tailscale-funnel).

## Choose the scope of your first setup

A generic Linux VM can run plans and implementations without Docker or the Jetson gateway. The shipped preview script additionally requires the existing Calify/gateway contracts and contains Jetson-specific paths. It is not a generic application installer.

Continue with [GitHub setup](GitHub-Setup.md).
