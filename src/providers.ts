import { spawn } from "node:child_process";
import path from "node:path";
import type {
  AgentCommand,
  AgentConfig,
  Invocation,
  ProviderName,
  TaskContext,
} from "./types.js";

export function createInvocation(
  command: AgentCommand,
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
      command === "plan" ? "read-only" : "workspace-write",
      "--color",
      "never",
      "--ephemeral",
      "--ignore-user-config",
    ];
    if (providerConfig.model !== undefined) {
      args.push("--model", providerConfig.model);
    }
    for (const attachment of task.attachments ?? []) {
      if (attachment.kind === "image") {
        args.push(
          "--image",
          path.resolve(task.workingDirectory, attachment.path),
        );
      }
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
    "--no-session-persistence",
    "--safe-mode",
    "--tools",
    command === "plan" ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write",
    "--permission-mode",
    command === "plan" ? "plan" : "acceptEdits",
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

export interface InvocationResult {
  exitCode: number;
  stdout: string;
}

export async function runInvocation(
  invocation: Invocation,
): Promise<InvocationResult> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "inherit"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      process.stdout.write(chunk);
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
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(chunks).toString() });
    });

    child.stdin.end(invocation.stdin);
  });
}
