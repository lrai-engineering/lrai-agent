import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInvocation, runInvocation } from "../src/providers.js";
import type { AgentConfig, TaskContext } from "../src/types.js";

const config: AgentConfig = {
  version: 1,
  provider: "codex",
  plan: { prompt: "prompts/plan.md" },
  implement: { prompt: "prompts/implement.md" },
  providers: {
    codex: {
      executable: "codex",
    },
    claude: {
      executable: "claude",
    },
  },
};

const task: TaskContext = {
  repository: "owner/repo",
  issueNumber: "1",
  title: "Task",
  body: "Body",
  sender: "luke",
  workingDirectory: "/tmp/repo with spaces",
};

describe("createInvocation", () => {
  it("passes Codex arguments without a shell", () => {
    const invocation = createInvocation(
      "plan",
      "codex",
      config,
      task,
      "prompt",
    );

    expect(invocation.executable).toBe("codex");
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).toContain("--ignore-user-config");
    expect(invocation.args).toContain("/tmp/repo with spaces");
    expect(invocation.args.at(-1)).toBe("-");
    expect(invocation.stdin).toBe("prompt");
  });

  it("uses Claude's plan permission mode", () => {
    const invocation = createInvocation(
      "plan",
      "claude",
      config,
      task,
      "prompt",
    );

    expect(invocation.executable).toBe("claude");
    expect(invocation.args).toEqual([
      "--print",
      "--output-format",
      "text",
      "--no-session-persistence",
      "--safe-mode",
      "--tools",
      "Read,Glob,Grep",
      "--permission-mode",
      "plan",
    ]);
  });

  it("confines Codex implementation to workspace-write", () => {
    const invocation = createInvocation(
      "implement",
      "codex",
      config,
      task,
      "prompt",
    );

    expect(invocation.args).toContain("workspace-write");
    expect(invocation.args).not.toContain("danger-full-access");
  });

  it("allows Claude file edits without Bash or network tools", () => {
    const invocation = createInvocation(
      "implement",
      "claude",
      config,
      task,
      "prompt",
    );

    expect(invocation.args).toContain("acceptEdits");
    expect(invocation.args).toContain("Read,Glob,Grep,Edit,Write");
    expect(invocation.args.join(" ")).not.toContain("Bash");
    expect(invocation.args.join(" ")).not.toContain("WebFetch");
  });
});

describe("runInvocation", () => {
  it("captures stdout and preserves the child exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lrai-agent-provider-test-"));
    const fakeExecutable = join(dir, "fake-provider.js");
    // A local fixture standing in for a real provider CLI: it echoes stdin
    // back to stdout, then exits with a distinctive non-zero code so the
    // test can tell the exit code was preserved rather than defaulted.
    await writeFile(
      fakeExecutable,
      [
        "#!/usr/bin/env node",
        'process.stdin.on("data", (chunk) => process.stdout.write(chunk));',
        'process.stdin.on("end", () => process.exit(7));',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const result = await runInvocation({
        executable: fakeExecutable,
        args: [],
        cwd: dir,
        stdin: "captured provider output\n",
      });

      expect(result.stdout).toBe("captured provider output\n");
      expect(result.exitCode).toBe(7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
