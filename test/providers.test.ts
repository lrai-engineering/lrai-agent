import { describe, expect, it } from "vitest";
import { createInvocation } from "../src/providers.js";
import { loadConfig } from "../src/config.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  it.each(["plan", "implement"] as const)("uses Astra medium for %s by default", async (command) => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-provider-"));
    const loaded = await loadConfig(directory, undefined);
    const invocation = createInvocation(command, "codex", loaded.config, task, "prompt");
    expect(invocation.args).toContain("--ignore-user-config");
    expect(invocation.args.slice(invocation.args.indexOf("--model"), invocation.args.indexOf("--model") + 4))
      .toEqual(["--model", "gpt-6-astra", "--config", 'model_reasoning_effort="medium"']);
    expect(invocation.args[invocation.args.indexOf("--sandbox") + 1])
      .toBe(command === "plan" ? "read-only" : "workspace-write");
  });

  it("passes explicit Codex model and effort overrides as separate arguments", () => {
    const overridden = { ...config, providers: { ...config.providers,
      codex: { executable: "codex", model: "gpt-5.6-sol", reasoningEffort: "high" as const },
    } };
    const invocation = createInvocation("plan", "codex", overridden, task, "prompt");
    expect(invocation.args.slice(-5)).toEqual([
      "--model", "gpt-5.6-sol", "--config", 'model_reasoning_effort="high"', "-",
    ]);
  });

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

  it("attaches downloaded images to Codex without treating other files as images", () => {
    const invocation = createInvocation(
      "plan",
      "codex",
      config,
      {
        ...task,
        attachments: [
          {
            sourceUrl: "https://github.com/user-attachments/assets/image",
            path: ".lrai-agent-attachments/screenshot.png",
            mediaType: "image/png",
            size: 9,
            kind: "image",
          },
          {
            sourceUrl: "https://github.com/user-attachments/files/log",
            path: ".lrai-agent-attachments/server.log",
            mediaType: "text/plain",
            size: 20,
            kind: "text",
          },
        ],
      },
      "prompt",
    );

    expect(invocation.args).toContain("--image");
    expect(invocation.args).toContain(
      "/tmp/repo with spaces/.lrai-agent-attachments/screenshot.png",
    );
    expect(invocation.args).not.toContain(
      "/tmp/repo with spaces/.lrai-agent-attachments/server.log",
    );
    expect(invocation.args.at(-1)).toBe("-");
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
