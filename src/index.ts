#!/usr/bin/env node

import { parseArgs } from "node:util";
import { loadConfig, selectProvider } from "./config.js";
import { taskFromEnvironment } from "./github.js";
import { createInvocation, runInvocation } from "./providers.js";
import { loadPlanPrompt } from "./task.js";

const HELP = `lrai-agent v0.1

Usage:
  lrai-agent plan [options]

Options:
  --provider <codex|claude>  Override the configured provider
  --repository <owner/repo>  Repository name (or REPOSITORY/GITHUB_REPOSITORY)
  --issue-number <number>    GitHub issue number (or ISSUE_NUMBER)
  --title <text>             Task title (or ISSUE_TITLE)
  --body <text>              Task body (or ISSUE_BODY)
  --sender <login>           Requesting actor (or SENDER/GITHUB_ACTOR)
  --cwd <path>               Repository checkout (or GITHUB_WORKSPACE/current dir)
  --config <path>            Configuration file (or LRAI_CONFIG)
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
  if (command !== "plan") {
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
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const task = taskFromEnvironment({
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
  const loaded = await loadConfig(task.workingDirectory, values.config);
  const provider = selectProvider(loaded.config.provider, values.provider);
  const prompt = await loadPlanPrompt(loaded, task);
  const invocation = createInvocation(provider, loaded.config, task, prompt);

  if (values["dry-run"]) {
    process.stdout.write(
      `Provider: ${provider}\nCommand: ${shellDisplay(invocation.executable, invocation.args)}\n\n--- prompt ---\n${prompt}`,
    );
    return 0;
  }

  process.stderr.write(
    `LRAI Agent: planning ${task.repository}${task.issueNumber === undefined ? "" : `#${task.issueNumber}`} with ${provider}\n`,
  );
  return await runInvocation(invocation);
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
