import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedConfig, TaskContext } from "./types.js";

const TOKENS = [
  "repository",
  "issueReference",
  "sender",
  "title",
  "body",
] as const;

export function renderPrompt(template: string, task: TaskContext): string {
  const values: Record<(typeof TOKENS)[number], string> = {
    repository: task.repository,
    issueReference:
      task.issueNumber === undefined ? "local task" : `#${task.issueNumber}`,
    sender: task.sender,
    title: task.title,
    body: task.body,
  };

  let rendered = template;
  for (const token of TOKENS) {
    rendered = rendered.replaceAll(`{{${token}}}`, values[token]);
  }

  const unknownTokens = rendered.match(/{{[^{}]+}}/g);
  if (unknownTokens !== null) {
    throw new Error(`unknown prompt token(s): ${unknownTokens.join(", ")}`);
  }
  return rendered;
}

function packageRoot(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const parentDirectory = path.dirname(moduleDirectory);
  return path.basename(parentDirectory) === "dist"
    ? path.dirname(parentDirectory)
    : parentDirectory;
}

export async function loadPlanPrompt(
  loaded: LoadedConfig,
  task: TaskContext,
): Promise<string> {
  const configuredPath = loaded.config.plan.prompt;
  const baseDirectory = loaded.configDirectory ?? packageRoot();
  const promptPath = path.resolve(baseDirectory, configuredPath);

  try {
    return renderPrompt(await readFile(promptPath, "utf8"), task);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to load plan prompt ${promptPath}: ${message}`);
  }
}
