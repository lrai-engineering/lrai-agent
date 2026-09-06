import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("keeps the daemon alive and accepts another batch after a task fails", async () => {
  const spool = await mkdtemp(path.join(os.tmpdir(), "lrai-daemon-test-"));
  await writeFile(path.join(spool, "first.json"), "invalid JSON");
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "worker"], {
    env: { ...process.env, LRAI_WEBHOOK_SPOOL: spool }, stdio: ["ignore", "ignore", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  const waitForTask = async (name: string) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (logs.includes(`task ${name} failed`)) return;
      if (child.exitCode !== null) throw new Error(`worker exited: ${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`worker did not process ${name}: ${logs}`);
  };
  try {
    await waitForTask("first.json");
    await writeFile(path.join(spool, "second.json"), "invalid JSON");
    await waitForTask("second.json");
    expect(child.exitCode).toBeNull();
    expect((await readdir(spool)).sort()).toEqual(["first.json.failed", "second.json.failed"]);
  } finally {
    if (child.exitCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await stopped;
    }
    await rm(spool, { recursive: true, force: true });
  }
}, 10_000);
