import { describe, expect, it } from "vitest";
import { createInvocation } from "../src/providers.js";
import type { AgentConfig, TaskContext } from "../src/types.js";

const config: AgentConfig = {
  version: 1,
  provider: "codex",
  plan: { prompt: "prompts/plan.md" },
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
    const invocation = createInvocation("codex", config, task, "prompt");

    expect(invocation.executable).toBe("codex");
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).toContain("/tmp/repo with spaces");
    expect(invocation.args.at(-1)).toBe("-");
    expect(invocation.stdin).toBe("prompt");
  });

  it("uses Claude's plan permission mode", () => {
    const invocation = createInvocation("claude", config, task, "prompt");

    expect(invocation.executable).toBe("claude");
    expect(invocation.args).toEqual([
      "--print",
      "--output-format",
      "text",
      "--permission-mode",
      "plan",
    ]);
  });
});
