#!/usr/bin/env node

import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  fetchIssueAttachments,
  loadAttachmentManifest,
} from "./attachments.js";
import { loadConfig, selectProvider } from "./config.js";
import { taskFromEnvironment } from "./github.js";
import { createInvocation, runInvocation } from "./providers.js";
import { loadPrompt } from "./task.js";
import type { AgentCommand } from "./types.js";

const HELP = `lrai-agent v0.2

Usage:
  lrai-agent plan [options]
  lrai-agent implement [options]
  lrai-agent fetch-attachments [options]

Options:
  --provider <codex|claude>  Override the configured provider
  --repository <owner/repo>  Repository name (or REPOSITORY/GITHUB_REPOSITORY)
  --issue-number <number>    GitHub issue number (or ISSUE_NUMBER)
  --title <text>             Task title (or ISSUE_TITLE)
  --body <text>              Task body (or ISSUE_BODY)
  --sender <login>           Requesting actor (or SENDER/GITHUB_ACTOR)
  --cwd <path>               Repository checkout (or GITHUB_WORKSPACE/current dir)
  --config <path>            Configuration file (or LRAI_CONFIG)
  --output <path>            Write the provider's final output to a file
  --attachments <path>       Read a downloaded attachment manifest
  --dry-run                  Print the invocation and prompt without running it
  -h, --help                 Show this help
`;

function shellDisplay(executable: string, args: string[]): string {
  return [executable, ...args]
    .map((part) => (/^[A-Za-z0-9_./:=@-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (
    command !== "plan" &&
    command !== "implement" &&
    command !== "fetch-attachments"
  ) {
    throw new Error(`unknown command: ${command}\n\n${HELP}`);
  }

  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: {
      provider: { type: "string" },
      repository: { type: "string" },
      "issue-number": { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      sender: { type: "string" },
      cwd: { type: "string" },
      config: { type: "string" },
      output: { type: "string" },
      attachments: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "fetch-attachments") {
    const workingDirectory = path.resolve(
      values.cwd ?? process.env.GITHUB_WORKSPACE ?? process.cwd(),
    );
    const body = values.body ?? process.env.ISSUE_BODY ?? "";
    const manifestPath =
      values.output ?? ".lrai-agent-attachments/manifest.json";
    const token = process.env.GITHUB_TOKEN;
    const manifest = await fetchIssueAttachments({
      body,
      workingDirectory,
      manifestPath,
      ...(token === undefined ? {} : { token }),
    });
    process.stdout.write(
      `Downloaded ${manifest.attachments.length} GitHub attachment(s) to ${path.dirname(manifestPath)}\n`,
    );
    return 0;
  }

  let task = taskFromEnvironment({
    ...(values.repository === undefined
      ? {}
      : { repository: values.repository }),
    ...(values["issue-number"] === undefined
      ? {}
      : { issueNumber: values["issue-number"] }),
    ...(values.title === undefined ? {} : { title: values.title }),
    ...(values.body === undefined ? {} : { body: values.body }),
    ...(values.sender === undefined ? {} : { sender: values.sender }),
    ...(values.cwd === undefined ? {} : { workingDirectory: values.cwd }),
  });
  if (values.attachments !== undefined) {
    task = {
      ...task,
      attachments: await loadAttachmentManifest(
        task.workingDirectory,
        values.attachments,
      ),
    };
  }
  const loaded = await loadConfig(task.workingDirectory, values.config);
  const provider = selectProvider(loaded.config.provider, values.provider);
  const agentCommand: AgentCommand = command;
  const prompt = await loadPrompt(loaded, task, agentCommand);
  const invocation = createInvocation(
    agentCommand,
    provider,
    loaded.config,
    task,
    prompt,
  );

  if (values["dry-run"]) {
    process.stdout.write(
      `Provider: ${provider}\nCommand: ${shellDisplay(invocation.executable, invocation.args)}\n\n--- prompt ---\n${prompt}`,
    );
    return 0;
  }

  process.stderr.write(
    `LRAI Agent: ${agentCommand} ${task.repository}${task.issueNumber === undefined ? "" : `#${task.issueNumber}`} with ${provider}\n`,
  );
  const result = await runInvocation(invocation);
  if (values.output !== undefined) {
    const outputPath = path.resolve(task.workingDirectory, values.output);
    await writeFile(outputPath, result.stdout, { mode: 0o600 });
  }
  return result.exitCode;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`lrai-agent: ${message}\n`);
    process.exitCode = 1;
  });
