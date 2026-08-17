import { describe, expect, it } from "vitest";
import { taskFromEnvironment } from "../src/github.js";

describe("taskFromEnvironment", () => {
  it("normalizes the GitHub Actions environment", () => {
    const task = taskFromEnvironment(
      {},
      {
        GITHUB_REPOSITORY: "lrai-engineering/example",
        GITHUB_WORKSPACE: "/tmp/example",
        GITHUB_ACTOR: "luke",
        ISSUE_NUMBER: "12",
        ISSUE_TITLE: "Plan this",
        ISSUE_BODY: "Details",
      },
    );

    expect(task).toEqual({
      repository: "lrai-engineering/example",
      workingDirectory: "/tmp/example",
      sender: "luke",
      issueNumber: "12",
      title: "Plan this",
      body: "Details",
    });
  });

  it("rejects a malformed issue number", () => {
    expect(() =>
      taskFromEnvironment(
        { repository: "owner/repo", title: "Task", issueNumber: "1;pwd" },
        {},
      ),
    ).toThrow("issue number must contain only digits");
  });
});
