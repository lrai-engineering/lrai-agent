import { spawn } from "node:child_process";
import type {
  AgentConfig,
  Invocation,
  ProviderName,
  TaskContext,
} from "./types.js";

export function createInvocation(
  provider: ProviderName,
  config: AgentConfig,
  task: TaskContext,
  prompt: string,
): Invocation {
  if (provider === "codex") {
    const providerConfig = config.providers.codex;
    const args = [
      "exec",
      "--cd",
      task.workingDirectory,
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "--color",
      "never",
    ];
    if (providerConfig.model !== undefined) {
      args.push("--model", providerConfig.model);
    }
    args.push("-");
    return {
      executable: providerConfig.executable,
      args,
      cwd: task.workingDirectory,
      stdin: prompt,
    };
  }

  const providerConfig = config.providers.claude;
  const args = [
    "--print",
    "--output-format",
    "text",
    "--permission-mode",
    "plan",
  ];
  if (providerConfig.model !== undefined) {
    args.push("--model", providerConfig.model);
  }
  return {
    executable: providerConfig.executable,
    args,
    cwd: task.workingDirectory,
    stdin: prompt,
  };
}

export async function runInvocation(invocation: Invocation): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: process.env,
      stdio: ["pipe", "inherit", "inherit"],
    });

    child.once("error", (error) => {
      reject(
        new Error(`failed to start ${invocation.executable}: ${error.message}`),
      );
    });
    child.once("close", (code, signal) => {
      if (signal !== null) {
        reject(
          new Error(`${invocation.executable} terminated by signal ${signal}`),
        );
        return;
      }
      resolve(code ?? 1);
    });

    child.stdin.end(invocation.stdin);
  });
}
