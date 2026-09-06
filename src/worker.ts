import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInstallationToken } from "./github-app.js";
import { fetchIssueAttachments } from "./attachments.js";
import { loadConfig, selectProvider } from "./config.js";
import { createInvocation, runInvocation } from "./providers.js";
import { loadPrompt } from "./task.js";
import type { WebhookTask } from "./types.js";

interface PullRequestSummary {
  number: number;
  html_url: string;
  state: string;
  body?: string | null;
  title?: string;
  head: { ref: string; sha: string };
}

interface DiscussionEntry {
  id: number;
  body?: string | null;
  user?: { type?: string };
}

async function githubPages<T>(token: string, url: string): Promise<T[]> {
  const entries: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await githubJson<T[]>(token, `${url}?per_page=100&page=${page}`);
    entries.push(...batch);
    if (batch.length < 100) return entries;
  }
}

async function deploymentContext(token: string, repository: string, issueNumber: number, pr: PullRequestSummary): Promise<string> {
  const base = `https://api.github.com/repos/${repository}`;
  const [issue, ...discussions] = await Promise.all([
    githubJson<{ title?: string; body?: string | null }>(token, `${base}/issues/${issueNumber}`),
    ...[`${base}/issues/${issueNumber}/comments`, `${base}/issues/${pr.number}/comments`,
      `${base}/pulls/${pr.number}/comments`, `${base}/pulls/${pr.number}/reviews`]
      .map((url) => githubPages<DiscussionEntry>(token, url)),
  ] as const);
  // Content only: label timestamps and the bot's own deployment comments must
  // not invalidate a healthy preview. Read live data, not the queued snapshot.
  return createHash("sha256").update(JSON.stringify({
    issue: [issue.title ?? "", issue.body ?? ""],
    pr: [pr.title ?? "", pr.body ?? ""],
    discussions: discussions.map((entries) => entries.filter((entry) => entry.user?.type !== "Bot")
      .map((entry) => [entry.id, entry.body ?? ""])),
  })).digest("hex");
}

interface PreviewResult {
  status: "deployed" | "unchanged";
  url: string;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

async function runGit(args: string[], cwd: string, token: string): Promise<string> {
  const askpassPath = path.join(cwd, ".lrai-agent-askpass");
  await writeFile(askpassPath, "#!/bin/sh\ncase \"$1\" in *Username*) echo x-access-token ;; *) echo \"$GIT_PASSWORD\" ;; esac\n", { mode: 0o700 });
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: askpassPath, GIT_PASSWORD: token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`git failed (${code}): ${stderr.trim()}`)));
  }).finally(async () => { await rm(askpassPath, { force: true }); });
}

async function githubComment(token: string, repository: string, issueNumber: number, body: string): Promise<void> {
  const response = await fetch(`https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "x-github-api-version": "2022-11-28", "user-agent": "lrai-agent" },
    body: JSON.stringify({ body: body.slice(0, 64_000) }),
  });
  if (!response.ok) throw new Error(`GitHub issue comment failed (${response.status})`);
}

async function githubJson<T>(token: string, url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "lrai-agent",
    },
  });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status})`);
  return (await response.json()) as T;
}

async function removeIssueLabel(token: string, repository: string, issueNumber: number, label: string): Promise<void> {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "lrai-agent",
      },
    },
  );
  if (!response.ok && response.status !== 404) throw new Error(`GitHub label removal failed (${response.status})`);
}

async function createDraftPullRequest(token: string, repository: string, title: string, head: string, base: string, issueNumber: number): Promise<PullRequestSummary> {
  const response = await fetch(`https://api.github.com/repos/${repository}/pulls`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "x-github-api-version": "2022-11-28", "user-agent": "lrai-agent" },
    body: JSON.stringify({ title: title.slice(0, 240), head, base, draft: true, body: `Closes #${issueNumber}\n\nCreated by the bounded LRAI Agent worker. Review before merging.` }),
  });
  if (!response.ok) throw new Error(`GitHub draft PR creation failed (${response.status})`);
  const body = (await response.json()) as Partial<PullRequestSummary>;
  if (body.html_url === undefined || body.number === undefined || body.state === undefined || body.head === undefined) {
    throw new Error("GitHub draft PR response was incomplete");
  }
  return body as PullRequestSummary;
}

async function findLatestAgentPullRequest(token: string, repository: string, issueNumber: number): Promise<PullRequestSummary> {
  const comments = await githubPages<{ body?: string }>(
    token,
    `https://api.github.com/repos/${repository}/issues/${issueNumber}/comments`,
  );
  const marker = /<!-- lrai-agent-pr:(\d+) -->/g;
  const markerNumbers = comments
    .flatMap((comment) => [...(comment.body ?? "").matchAll(marker)].map((match) => Number(match[1])))
    .filter((number) => Number.isSafeInteger(number) && number > 0);
  const legacyNumbers = comments
    .flatMap((comment) => [...(comment.body ?? "").matchAll(/Draft implementation PR:\s+https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/g)].map((match) => Number(match[1])))
    .filter((number) => Number.isSafeInteger(number) && number > 0);
  const numbers = markerNumbers.length > 0 ? markerNumbers : legacyNumbers;
  const number = numbers.at(-1);
  if (number === undefined) throw new Error(`no lrai-agent implementation PR found for issue #${issueNumber}`);
  const pullRequest = await githubJson<PullRequestSummary>(
    token,
    `https://api.github.com/repos/${repository}/pulls/${number}`,
  );
  if (pullRequest.state !== "open") throw new Error(`implementation PR #${number} is not open`);
  if (!pullRequest.head.ref.startsWith(`agent/issue-${issueNumber}-`) || !pullRequest.body?.includes(`Closes #${issueNumber}`)) {
    throw new Error(`PR #${number} is not an lrai-agent implementation for issue #${issueNumber}`);
  }
  return pullRequest;
}

export async function deployPreview(token: string, repository: string, app: string | undefined, pullRequest: PullRequestSummary, contextSha: string): Promise<PreviewResult> {
  if (app === undefined) throw new Error("preview.app is required for deploy tasks");
  const command = process.env.LRAI_PREVIEW_DEPLOY_COMMAND === undefined
    ? [required(process.env.LRAI_PREVIEW_DEPLOY_EXECUTABLE, "LRAI_PREVIEW_DEPLOY_EXECUTABLE")]
    : JSON.parse(process.env.LRAI_PREVIEW_DEPLOY_COMMAND) as unknown;
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.trim() === "")) {
    throw new Error("LRAI_PREVIEW_DEPLOY_COMMAND must be a non-empty JSON string array");
  }
  const [executable, ...prefix] = command as string[];
  if (executable === undefined) throw new Error("preview deploy command executable is missing");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, [...prefix,
      "--repository", repository,
      "--pull-request", String(pullRequest.number),
      "--ref", pullRequest.head.ref,
      "--sha", pullRequest.head.sha,
      "--app", app,
      "--context-sha", contextSha,
    ], { env: { ...process.env, LRAI_GITHUB_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-16_000); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_000); });
    child.once("error", (error) => reject(new Error(`failed to start preview deployer: ${error.message}`)));
    child.once("close", (code, signal) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(`preview deployer exited ${signal ?? code}: ${(stderr.trim() || stdout.trim() || "no diagnostic output; check the worker journal").replaceAll(token, "[redacted]")}`)));
  });
  let result: PreviewResult;
  try { result = JSON.parse(output) as PreviewResult; } catch { throw new Error("preview deployer returned an invalid result; expected status and URL"); }
  if (result === null || (result.status !== "deployed" && result.status !== "unchanged") ||
    typeof result.url !== "string" || !/^https:\/\/[^\s]+$/.test(result.url)) {
    throw new Error("preview deployer returned an invalid status or HTTPS URL");
  }
  return result;
}

function providerAndCommand(command: string): { provider: "codex" | "claude"; mode: "plan" | "implement" } {
  if (command === "codex" || command === "codex-plan") return { provider: "codex", mode: command.endsWith("-plan") ? "plan" : "implement" };
  if (command === "claude" || command === "claude-plan") return { provider: "claude", mode: command.endsWith("-plan") ? "plan" : "implement" };
  throw new Error(`unsupported queued command: ${command}`);
}

export async function processSpoolTask(spoolDirectory: string, filename: string): Promise<void> {
  const processing = `${filename}.processing`;
  try { await rename(path.join(spoolDirectory, filename), path.join(spoolDirectory, processing)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let outcome = "failed";
  try {
    await executeSpoolTask(spoolDirectory, processing);
    outcome = "done";
  } finally {
    await rename(path.join(spoolDirectory, processing), path.join(spoolDirectory, `${filename}.${outcome}`));
  }
}

async function executeSpoolTask(spoolDirectory: string, processing: string): Promise<void> {
  const task = JSON.parse(await readFile(path.join(spoolDirectory, processing), "utf8")) as WebhookTask;
  const repository = required(task.repository, "queued repository");
  const issueNumber = task.issueNumber;
  if (issueNumber === undefined || task.installationId === undefined) throw new Error("queued task is missing issue or installation identity");
  const appId = required(process.env.LRAI_GITHUB_APP_ID, "LRAI_GITHUB_APP_ID");
  const privateKeyPath = required(process.env.LRAI_GITHUB_PRIVATE_KEY_PATH, "LRAI_GITHUB_PRIVATE_KEY_PATH");
  const { token } = await createInstallationToken({ appId, privateKeyPath, installationId: task.installationId });
  const deployOnly = task.command === "deploy";
  const { provider, mode } = deployOnly
    ? { provider: "codex" as const, mode: "implement" as const }
    : providerAndCommand(task.command);
  const workspace = await mkdtemp(path.join(tmpdir(), "lrai-agent-task-"));
  try {
    for (const label of task.consumeLabels ?? []) await removeIssueLabel(token, repository, issueNumber, label);
    await runGit(["clone", `https://github.com/${repository}.git`, workspace], tmpdir(), token);
    const loaded = await loadConfig(workspace);
    await githubComment(token, repository, issueNumber, deployOnly
      ? `Started preview deployment run for delivery \`${task.delivery}\`.`
      : `Started ${provider} ${mode} run for delivery \`${task.delivery}\`.`);
    let pullRequest: PullRequestSummary | undefined;
    let providerOutput = "";
    if (deployOnly) {
      pullRequest = await findLatestAgentPullRequest(token, repository, issueNumber);
    } else {
      const manifestPath = path.join(workspace, ".lrai-agent-attachments", "manifest.json");
      const manifest = await fetchIssueAttachments({ body: task.body ?? "", workingDirectory: workspace, manifestPath, token });
      const context = { repository, issueNumber: String(issueNumber), title: task.title ?? "GitHub issue", body: task.body ?? "", sender: task.sender ?? "unknown", workingDirectory: workspace, attachments: manifest.attachments };
      const prompt = await loadPrompt(loaded, context, mode);
      const invocation = createInvocation(mode, selectProvider(loaded.config.provider, provider), loaded.config, context, prompt);
      const result = await runInvocation(invocation);
      if (result.exitCode !== 0) throw new Error(`${provider} exited with code ${result.exitCode}`);
      providerOutput = result.stdout;
      if (mode === "implement") {
        await rm(path.join(workspace, ".lrai-agent-attachments"), { recursive: true, force: true });
        const changes = await runGit(["status", "--porcelain"], workspace, token);
        if (changes.trim() === "") throw new Error("implementation produced no working-tree changes");
        const branch = `agent/issue-${issueNumber}-${task.delivery.slice(0, 8).toLowerCase()}`;
        await runGit(["switch", "-c", branch], workspace, token);
        await runGit(["add", "--all"], workspace, token);
        await runGit([
          "-c", "core.hooksPath=/dev/null",
          "-c", "user.name=lrai-engineering-agent[bot]",
          "-c", "user.email=lrai-engineering-agent[bot]@users.noreply.github.com",
          "commit", "-m", `issue #${issueNumber}: agent implementation`,
        ], workspace, token);
        await runGit(["push", "--set-upstream", "origin", branch], workspace, token);
        pullRequest = await createDraftPullRequest(token, repository, task.title ?? `Issue #${issueNumber}`, branch, task.defaultBranch ?? "main", issueNumber);
        await githubComment(token, repository, issueNumber, `Draft implementation PR: ${pullRequest.html_url}\n\n<!-- lrai-agent-pr:${pullRequest.number} -->\n\n## ${provider} output\n\n${providerOutput}`);
      } else {
        await githubComment(token, repository, issueNumber, `## ${provider} ${mode}\n\n${providerOutput}`);
      }
    }
    if (task.deployPreview) {
      if (pullRequest === undefined) throw new Error("deploy was requested but implementation did not create a pull request");
      const contextSha = await deploymentContext(token, repository, issueNumber, pullRequest);
      const preview = await deployPreview(token, repository, loaded.config.preview?.app, pullRequest, contextSha);
      await githubComment(token, repository, issueNumber, preview.status === "unchanged"
        ? `Nothing changed in PR #${pullRequest.number} or its issue; no redeploy needed.\n\nURL: ${preview.url}\nCommit: \`${pullRequest.head.sha}\``
        : `Preview deployed for PR #${pullRequest.number}.\n\nURL: ${preview.url}\nCommit: \`${pullRequest.head.sha}\``);
    } else if (deployOnly && pullRequest !== undefined) {
      await githubComment(token, repository, issueNumber, `Implementation PR found: ${pullRequest.html_url}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await githubComment(token, repository, issueNumber, `${deployOnly ? "The preview deployment" : `The ${provider} ${mode} run`} failed: ${message}`); } catch { /* preserve original failure */ }
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function runWorker(spoolDirectory: string, once: boolean): Promise<void> {
  for (;;) {
    const files = (await readdir(spoolDirectory)).filter((file) => file.endsWith(".json"));
    const failures: unknown[] = [];
    for (const file of files) {
      try { await processSpoolTask(spoolDirectory, file); } catch (error) {
        failures.push(error);
        process.stderr.write(`lrai-agent: task ${file} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (once) {
      if (failures.length > 0) throw new AggregateError(failures, `${failures.length} queued task(s) failed`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
