import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, selectProvider } from "../src/config.js";

describe("loadConfig", () => {
  it("uses safe planning defaults when no repository config exists", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-config-"));
    const loaded = await loadConfig(directory, undefined);

    expect(loaded.config.provider).toBe("codex");
    expect(loaded.config.implement.prompt).toBe("prompts/implement.md");
    expect(loaded.config.providers.codex.executable).toBe("codex");
    expect(loaded.config.providers.codex.model).toBe("gpt-6-astra");
    expect(loaded.config.providers.codex.reasoningEffort).toBe("medium");
    expect(loaded.config.providers.claude.executable).toBe("claude");
  });

  it("merges repository overrides", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-config-"));
    await writeFile(
      path.join(directory, ".lrai-agent.yml"),
      "version: 1\nprovider: claude\npreview:\n  app: calify\nproviders:\n  claude:\n    model: sonnet\n",
    );

    const loaded = await loadConfig(directory, undefined);
    expect(loaded.config.provider).toBe("claude");
    expect(loaded.config.providers.claude.model).toBe("sonnet");
    expect(loaded.config.providers.codex.executable).toBe("codex");
    expect(loaded.config.preview?.app).toBe("calify");
    expect(loaded.config.providers.codex.model).toBe("gpt-6-astra");
    expect(loaded.config.providers.codex.reasoningEffort).toBe("medium");
  });

  it("allows explicit model and reasoning overrides", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-config-"));
    await writeFile(path.join(directory, ".lrai-agent.yml"),
      "providers:\n  codex:\n    model: gpt-5.6-sol\n    reasoningEffort: high\n");
    const loaded = await loadConfig(directory, undefined);
    expect(loaded.config.providers.codex.model).toBe("gpt-5.6-sol");
    expect(loaded.config.providers.codex.reasoningEffort).toBe("high");
  });

  it.each(["turbo", "", 42, null])("rejects invalid reasoning effort %j", async (effort) => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-config-"));
    await writeFile(path.join(directory, ".lrai-agent.yml"), JSON.stringify({
      providers: { codex: { reasoningEffort: effort } },
    }));
    await expect(loadConfig(directory, undefined)).rejects.toThrow("providers.codex.reasoningEffort must be one of");
  });

  it("rejects unsafe preview application names", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-config-"));
    await writeFile(path.join(directory, ".lrai-agent.yml"), "version: 1\npreview:\n  app: ../gateway\n");
    await expect(loadConfig(directory, undefined)).rejects.toThrow("preview.app");
  });

  it("rejects an unknown provider", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-config-"));
    await writeFile(
      path.join(directory, ".lrai-agent.yml"),
      "version: 1\nprovider: other\n",
    );

    await expect(loadConfig(directory, undefined)).rejects.toThrow(
      "provider must be one of",
    );
  });

  it("does not let repository config replace worker executables", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-config-"));
    await writeFile(
      path.join(directory, ".lrai-agent.yml"),
      "version: 1\nproviders:\n  codex:\n    executable: ./from-repository\n",
    );

    await expect(loadConfig(directory, undefined)).rejects.toThrow(
      "provider executables are worker settings",
    );
  });

  it("allows an explicit worker config to select executable paths", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-config-"));
    await writeFile(
      path.join(directory, "worker.yml"),
      "version: 1\nproviders:\n  codex:\n    executable: /opt/lrai/bin/codex\n",
    );

    const loaded = await loadConfig(directory, "worker.yml");
    expect(loaded.config.providers.codex.executable).toBe(
      "/opt/lrai/bin/codex",
    );
  });

  it("tracks custom prompt origins independently", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lrai-config-"));
    await writeFile(
      path.join(directory, ".lrai-agent.yml"),
      "version: 1\nplan:\n  prompt: custom-plan.md\n",
    );

    const loaded = await loadConfig(directory, undefined);
    expect(loaded.promptDirectories?.plan).toBe(directory);
    expect(loaded.promptDirectories?.implement).toBeUndefined();
  });
});

describe("selectProvider", () => {
  it("accepts an explicit supported provider", () => {
    expect(selectProvider("codex", "claude")).toBe("claude");
  });

  it("rejects unsupported providers", () => {
    expect(() => selectProvider("codex", "other")).toThrow(
      "provider must be codex or claude",
    );
  });
});
