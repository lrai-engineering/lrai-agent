import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { loadPlanPrompt, renderPrompt } from "../src/task.js";

describe("renderPrompt", () => {
  it("renders task fields as data", () => {
    const output = renderPrompt(
      "{{repository}} {{issueReference}} {{sender}} {{title}} {{body}}",
      {
        repository: "owner/repo",
        issueNumber: "7",
        sender: "luke",
        title: "A title",
        body: "A body",
        workingDirectory: "/tmp/repo",
      },
    );

    expect(output).toBe("owner/repo #7 luke A title A body");
  });

  it("fails when a template contains an unsupported token", () => {
    expect(() =>
      renderPrompt("{{secret}}", {
        repository: "owner/repo",
        sender: "luke",
        title: "A title",
        body: "A body",
        workingDirectory: "/tmp/repo",
      }),
    ).toThrow("unknown prompt token");
  });

  it("keeps the packaged prompt when a repository only overrides provider", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-prompt-"));
    await writeFile(
      path.join(directory, ".lrai-agent.yml"),
      "version: 1\nprovider: claude\n",
    );
    const loaded = await loadConfig(directory, undefined);
    const prompt = await loadPlanPrompt(loaded, {
      repository: "owner/repo",
      sender: "luke",
      title: "A title",
      body: "A body",
      workingDirectory: directory,
    });

    expect(prompt).toContain("Repository: owner/repo");
    expect(prompt).toContain("Do not modify files");
  });

  it("resolves an explicit prompt relative to repository config", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-prompt-"));
    await writeFile(
      path.join(directory, ".lrai-agent.yml"),
      "version: 1\nplan:\n  prompt: custom-plan.md\n",
    );
    await writeFile(
      path.join(directory, "custom-plan.md"),
      "Plan {{repository}}: {{title}}",
    );
    const loaded = await loadConfig(directory, undefined);
    const prompt = await loadPlanPrompt(loaded, {
      repository: "owner/repo",
      sender: "luke",
      title: "A title",
      body: "A body",
      workingDirectory: directory,
    });

    expect(prompt).toBe("Plan owner/repo: A title");
  });
});
