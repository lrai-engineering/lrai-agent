import path from "node:path";
import type { TaskContext } from "./types.js";

export interface TaskOverrides {
  repository?: string;
  issueNumber?: string;
  title?: string;
  body?: string;
  sender?: string;
  workingDirectory?: string;
}

function firstValue(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

export function taskFromEnvironment(
  overrides: TaskOverrides,
  environment: NodeJS.ProcessEnv = process.env,
): TaskContext {
  const workingDirectory = path.resolve(
    firstValue(overrides.workingDirectory, environment.GITHUB_WORKSPACE) ??
      process.cwd(),
  );
  const repository = firstValue(
    overrides.repository,
    environment.REPOSITORY,
    environment.GITHUB_REPOSITORY,
  );
  const title = firstValue(overrides.title, environment.ISSUE_TITLE);
  const issueNumber = firstValue(
    overrides.issueNumber,
    environment.ISSUE_NUMBER,
  );

  if (repository === undefined) {
    throw new Error(
      "repository is required (--repository, REPOSITORY, or GITHUB_REPOSITORY)",
    );
  }
  if (title === undefined) {
    throw new Error("title is required (--title or ISSUE_TITLE)");
  }
  if (issueNumber !== undefined && !/^\d+$/.test(issueNumber)) {
    throw new Error("issue number must contain only digits");
  }

  return {
    repository,
    ...(issueNumber === undefined ? {} : { issueNumber }),
    title,
    body: overrides.body ?? environment.ISSUE_BODY ?? "(no issue body provided)",
    sender:
      firstValue(
        overrides.sender,
        environment.SENDER,
        environment.GITHUB_ACTOR,
      ) ?? "unknown",
    workingDirectory,
  };
}
