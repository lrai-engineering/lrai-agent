import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readdir, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createInstallationToken } from "../src/github-app.js";
import { deployPreview, processSpoolTask, runWorker } from "../src/worker.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../src/github-app.js", () => ({ createInstallationToken: vi.fn() }));
vi.mock("../src/config.js", () => ({ loadConfig: vi.fn(async () => ({ config: { preview: { app: "calify" } } })), selectProvider: vi.fn() }));

const pr = { number: 3, title: "Preview", html_url: "https://github.com/lukasijus/calify/pull/3", state: "open", body: "Closes #2", head: { ref: "agent/issue-2-test", sha: "a".repeat(40) } };
const url = "https://jetson.tail68fd31.ts.net/calify-pr-3";
let spool: string;
let workspace: string;
let output: string;
let stderr: string;
let exitCode: number;
let issueBody: string;
let comments: Array<{ id: number; body: string; user: { type: string } }>;
let published: string[];
let requests: Array<{ url: string; init?: RequestInit }>;
let calls: Array<{ command: string; args: string[]; options: { env: Record<string, string> } }>;

beforeEach(async () => {
  spool = await mkdtemp(path.join(os.tmpdir(), "lrai-worker-test-"));
  workspace = "";
  output = JSON.stringify({ status: "unchanged", url });
  stderr = "";
  exitCode = 0;
  issueBody = "Build a calendar";
  comments = [];
  published = [];
  requests = [];
  calls = [];
  vi.stubEnv("LRAI_GITHUB_APP_ID", "123");
  vi.stubEnv("LRAI_GITHUB_PRIVATE_KEY_PATH", "/not/a/real/key");
  vi.stubEnv("LRAI_PREVIEW_DEPLOY_COMMAND", '["/test/deployer"]');
  vi.mocked(createInstallationToken).mockResolvedValue({ token: "ghs_test_secret", expiresAt: "2099-01-01" });
  vi.mocked(spawn).mockImplementation(((command: string, args: string[], options: { env: Record<string, string> }) => {
    calls.push({ command, args, options });
    if (command === "git") workspace = args.at(-1)!;
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      if (command !== "git") {
        child.stdout.write(output);
        child.stderr.write(stderr);
      }
      child.emit("close", command === "git" ? 0 : exitCode, null);
    });
    return child;
  }) as unknown as typeof spawn);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    requests.push({ url: input, ...(init ? { init } : {}) });
    if (init?.method === "POST") {
      published.push((JSON.parse(String(init.body)) as { body: string }).body);
      return new Response("{}", { status: 201 });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (input.endsWith("/pulls/3")) return Response.json(pr);
    if (input.endsWith("/issues/2")) return Response.json({ title: "Calendar", body: issueBody });
    if (input.includes("/issues/2/comments")) return Response.json([
      { id: 1, body: "<!-- lrai-agent-pr:3 -->", user: { type: "Bot" } }, ...comments,
    ]);
    return Response.json([]);
  }));
});

afterEach(async () => {
  await rm(spool, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function enqueue(name = "delivery.json") {
  await writeFile(path.join(spool, name), JSON.stringify({ delivery: name, repository: "lukasijus/calify", installationId: 10, issueNumber: 2, command: "deploy", deployPreview: true, consumeLabels: ["deploy"], body: "stale queued text" }));
}

function contextSha() {
  const args = calls.filter((call) => call.command === "/test/deployer").at(-1)!.args;
  return args[args.indexOf("--context-sha") + 1];
}

describe("preview worker", () => {
  it("reports unchanged with URL, passes exact identity and token, and cleans its workspace", async () => {
    await enqueue();
    await processSpoolTask(spool, "delivery.json");
    expect(published.at(-1)).toContain("Nothing changed");
    expect(published.at(-1)).toContain(url);
    expect(calls.at(-1)?.args).toEqual(["--repository", "lukasijus/calify", "--pull-request", "3", "--ref", pr.head.ref, "--sha", pr.head.sha, "--app", "calify", "--context-sha", expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(calls.at(-1)?.options.env.LRAI_GITHUB_TOKEN).toBe("ghs_test_secret");
    expect(await readdir(spool)).toEqual(["delivery.json.done"]);
    await expect(access(workspace)).rejects.toThrow();
    expect(requests.some((request) => request.url.includes("/labels/deploy") && request.init?.method === "DELETE")).toBe(true);
    expect(requests.every((request) => (request.init?.headers as Record<string, string>).authorization === "Bearer ghs_test_secret")).toBe(true);
    expect(requests.some((request) => request.url.endsWith("/pulls") && request.init?.method === "POST")).toBe(false);
  });

  it("changes context for live edits and human discussion, but ignores bot comments", async () => {
    await enqueue(); await processSpoolTask(spool, "delivery.json");
    const original = contextSha();
    comments.push({ id: 2, body: "Preview deployed", user: { type: "Bot" } });
    await enqueue(); await processSpoolTask(spool, "delivery.json");
    expect(contextSha()).toBe(original);
    issueBody = "Updated request";
    await enqueue(); await processSpoolTask(spool, "delivery.json");
    expect(contextSha()).not.toBe(original);
    const edited = contextSha();
    comments.push({ id: 3, body: "Please adjust the calendar", user: { type: "User" } });
    await enqueue(); await processSpoolTask(spool, "delivery.json");
    expect(contextSha()).not.toBe(edited);
  });

  it("reports a completed deployment distinctly", async () => {
    output = JSON.stringify({ status: "deployed", url });
    await enqueue(); await processSpoolTask(spool, "delivery.json");
    expect(published.at(-1)).toContain("Preview deployed for PR #3");
    expect(published.at(-1)).toContain(url);
  });

  it("finds PRs and detects discussion edits beyond the first page of comments", async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    const firstPage = Array.from({ length: 100 }, (_, id) => ({ id, body: "Bot progress", user: { type: "Bot" } }));
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/issues/2/comments?per_page=100&page=1")) return Response.json(firstPage);
      return originalFetch(input, init);
    });
    await enqueue(); await processSpoolTask(spool, "delivery.json");
    const original = contextSha();
    comments.push({ id: 101, body: "Later feedback", user: { type: "User" } });
    await enqueue(); await processSpoolTask(spool, "delivery.json");
    expect(contextSha()).not.toBe(original);
    expect(published.at(-1)).toContain(url);
  });

  it("detects edits to the PR description", async () => {
    await enqueue(); await processSpoolTask(spool, "delivery.json");
    const original = contextSha();
    pr.body = "Closes #2\nUpdated PR details";
    try {
      await enqueue(); await processSpoolTask(spool, "delivery.json");
      expect(contextSha()).not.toBe(original);
    } finally { pr.body = "Closes #2"; }
  });

  it("archives a failed task and processes the next task in the same worker", async () => {
    await writeFile(path.join(spool, "broken.json"), "invalid JSON");
    await enqueue();
    const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await expect(runWorker(spool, true)).rejects.toThrow("1 queued task(s) failed");
      expect((await readdir(spool)).sort()).toEqual(["broken.json.failed", "delivery.json.done"]);
      expect(published.at(-1)).toContain(url);
    } finally { log.mockRestore(); }
  });

  it("archives token failures without leaving a stuck processing file", async () => {
    vi.mocked(createInstallationToken).mockRejectedValueOnce(new Error("token unavailable"));
    await enqueue();
    await expect(processSpoolTask(spool, "delivery.json")).rejects.toThrow("token unavailable");
    expect(await readdir(spool)).toEqual(["delivery.json.failed"]);
    expect(published).toEqual([]);
  });

  it("reports deploy failure diagnostics and cleans the workspace", async () => {
    exitCode = 1; output = ""; stderr = "build failed";
    await enqueue();
    await expect(processSpoolTask(spool, "delivery.json")).rejects.toThrow("build failed");
    expect(published.at(-1)).toContain("build failed");
    expect(await readdir(spool)).toEqual(["delivery.json.failed"]);
    await expect(access(workspace)).rejects.toThrow();
  });

  it("never deploys a closed implementation PR", async () => {
    pr.state = "closed";
    try {
      await enqueue();
      await expect(processSpoolTask(spool, "delivery.json")).rejects.toThrow("not open");
      expect(calls.every((call) => call.command === "git")).toBe(true);
    } finally { pr.state = "open"; }
  });

  it("includes stdout when stderr is empty and redacts the installation token", async () => {
    exitCode = 1; output = "failure ghs_test_secret";
    await expect(deployPreview("ghs_test_secret", "lukasijus/calify", "calify", pr, "b".repeat(64))).rejects.toThrow("failure [redacted]");
    output = "";
    await expect(deployPreview("ghs_test_secret", "lukasijus/calify", "calify", pr, "b".repeat(64))).rejects.toThrow("no diagnostic output");
  });

  it("rejects success without a usable result", async () => {
    output = "";
    await expect(deployPreview("ghs_test_secret", "lukasijus/calify", "calify", pr, "b".repeat(64))).rejects.toThrow("invalid result");
  });
});
