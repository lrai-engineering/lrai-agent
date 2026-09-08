import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const sha = "a".repeat(40);
const context = "b".repeat(64);
let root: string;
let state: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "lrai-preview-test-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  state = path.join(root, "previews/apps/calify/calify-pr-3.context-sha");
  await mkdir(path.dirname(state), { recursive: true });
  const script = await readFile(new URL("../deploy/jetson/lrai-agent-preview-deploy.sh", import.meta.url), "utf8");
  await writeFile(path.join(root, "deploy.sh"), script.replaceAll("/var/lib/lrai-agent", root));
  await writeFile(path.join(bin, "git"), `#!/bin/bash
echo "git $*" >> "$TEST_ROOT/calls"
if [[ "$1" == clone ]]; then
  for destination in "$@"; do :; done
  touch "$destination/compose.yaml"
else
  echo "$TEST_SHA"
fi
`, { mode: 0o755 });
  await writeFile(path.join(bin, "docker"), `#!/bin/bash
echo "docker $*" >> "$TEST_ROOT/calls"
if [[ "$1" == inspect ]]; then
  case "$3" in
    *repository*) echo lukasijus/calify ;;
    *pull-request*) echo 3 ;;
    *preview.sha*)
      if [[ -f "$TEST_ROOT/built" ]]; then echo "$TEST_SHA"; else echo "$TEST_EXISTING_SHA"; fi ;;
    *State.Status*) echo running ;;
    *Aliases*) if [[ "$TEST_SHARED_ALIAS" == 1 ]]; then echo '["calify-pr-3","calify"]'; else echo '[]'; fi ;;
  esac
elif [[ "$1" == exec && "$*" == *required-server-files.json* ]]; then
  echo "\${TEST_BASE_PATH:-/calify-pr-3}"
elif [[ "$1" == exec && "$*" == *"cat /etc/nginx/previews.conf"* ]]; then
  if [[ "$TEST_STALE_MOUNT" == 1 && ! -f "$TEST_ROOT/remounted" ]]; then echo stale; else cat "$TEST_ROOT/previews/gateway/previews.conf"; fi
elif [[ "$1" == compose && "$*" == *"--force-recreate gateway"* ]]; then
  touch "$TEST_ROOT/remounted"
elif [[ "$1" == compose && "$*" == *--build* ]]; then
  if [[ "$TEST_BUILD_FAIL" == 1 ]]; then echo "fixture build failed"; exit 17; fi
  touch "$TEST_ROOT/built"
fi
`, { mode: 0o755 });
  await writeFile(path.join(bin, "curl"), `#!/bin/bash
echo "curl $*" >> "$TEST_ROOT/calls"
if [[ "$TEST_UNHEALTHY" == 1 && ! -f "$TEST_ROOT/built" ]]; then exit 22; fi
exit 0
`, { mode: 0o755 });
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_ROOT: root, TEST_SHA: sha, TEST_EXISTING_SHA: sha, LRAI_GITHUB_TOKEN: "test-token", DOCKER_CONFIG: path.join(root, ".docker") };
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function deploy(requestedSha = sha, requestedContext = context) {
  return exec("bash", [path.join(root, "deploy.sh"), "--repository", "lukasijus/calify", "--pull-request", "3", "--ref", "agent/issue-2-test", "--sha", requestedSha, "--app", "calify", "--context-sha", requestedContext], { env });
}

describe("Jetson preview deployer", () => {
  it("reports a hardcoded base path without retrying impossible health checks", async () => {
    env.TEST_BASE_PATH = "/calify";
    await expect(deploy()).rejects.toMatchObject({ stderr: expect.stringContaining("Preview basePath mismatch") });
    const calls = await readFile(path.join(root, "calls"), "utf8");
    expect(calls).not.toContain("nginx -s reload");
    await expect(readFile(state, "utf8")).rejects.toThrow();
  });
  it("returns zero after deployment cleanup and records verified context", async () => {
    const result = await deploy();
    expect(JSON.parse(result.stdout)).toEqual({ status: "deployed", url: "https://jetson.tail68fd31.ts.net/calify-pr-3" });
    expect(await readFile(state, "utf8")).toBe(`${context}\n`);
    const calls = await readFile(path.join(root, "calls"), "utf8");
    expect(calls).toContain("--force-recreate");
    expect(calls).toContain("nginx -s reload");
  });

  it("reuses the healthy exact commit and context without cloning or changing containers", async () => {
    await writeFile(state, `${context}\n`);
    const result = await deploy();
    expect(JSON.parse(result.stdout).status).toBe("unchanged");
    const calls = await readFile(path.join(root, "calls"), "utf8");
    expect(calls).not.toContain("git ");
    expect(calls).not.toContain("docker compose");
    expect(calls).toContain("https://jetson.tail68fd31.ts.net/calify-pr-3");
  });

  it("recreates a gateway with a stale bind mount before publishing success", async () => {
    env.TEST_STALE_MOUNT = "1";
    expect(JSON.parse((await deploy()).stdout).status).toBe("deployed");
    expect(await readFile(path.join(root, "calls"), "utf8")).toContain("--force-recreate gateway");
  });

  it("removes the shared service alias so a PR cannot shadow main", async () => {
    env.TEST_SHARED_ALIAS = "1";
    expect(JSON.parse((await deploy()).stdout).status).toBe("deployed");
    const calls = await readFile(path.join(root, "calls"), "utf8");
    expect(calls).toContain("docker network disconnect calify_default calify-pr-3");
    expect(calls).toContain("docker network connect --alias calify-pr-3 calify_default calify-pr-3");
  });

  it("redeploys a new commit on the same branch", async () => {
    await writeFile(state, context);
    env.TEST_EXISTING_SHA = "c".repeat(40);
    expect(JSON.parse((await deploy()).stdout).status).toBe("deployed");
  });

  it("redeploys changed issue/PR content even on the same commit", async () => {
    await writeFile(state, "d".repeat(64));
    expect(JSON.parse((await deploy()).stdout).status).toBe("deployed");
  });

  it("repairs an unhealthy route instead of reporting unchanged", async () => {
    await writeFile(state, context);
    env.TEST_UNHEALTHY = "1";
    expect(JSON.parse((await deploy()).stdout).status).toBe("deployed");
  });

  it("does not mistake an old healthy container for a successful failed rebuild", async () => {
    const oldContext = "d".repeat(64);
    await writeFile(state, oldContext);
    env.TEST_BUILD_FAIL = "1";
    await expect(deploy()).rejects.toMatchObject({ code: 17, stderr: expect.stringContaining("fixture build failed") });
    expect(await readFile(state, "utf8")).toBe(oldContext);
  });

  it("rejects a ref that changed since GitHub was read", async () => {
    env.TEST_SHA = "e".repeat(40);
    await expect(deploy()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("does not match requested commit") });
    expect(await readFile(path.join(root, "calls"), "utf8")).not.toContain("docker compose");
  });
});
