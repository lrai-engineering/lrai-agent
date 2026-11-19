import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NUGET_DIRECTORY, PASSWD_FILE, sandboxArgs, validationPolicy } from "../src/workspace-validation.js";
import { providerEnvironment } from "../src/providers.js";

describe("worker isolation", () => {
  it("mounts only the checkout and public runtime, with offline validation and a clean environment", () => {
    const args = sandboxArgs("/tmp/repo with spaces", "/opt/lrai-agent", false, ["run", "build"]);
    expect(args).toContain("--unshare-all");
    expect(args).not.toContain("--share-net");
    expect(args).toContain("--clearenv");
    expect(args.slice(args.indexOf("--bind"), args.indexOf("--bind") + 3))
      .toEqual(["--bind", "/tmp/repo with spaces", "/tmp/repo with spaces"]);
    expect(args).not.toContain("/var/lib/lrai-agent");
    expect(args).not.toContain("/etc/lrai-agent");
    expect(args).not.toContain("/var/run/docker.sock");
    expect(args.slice(-4)).toEqual(["--", "/opt/lrai-agent/bin/pnpm", "run", "build"]);
  });

  it("shares network only for the separate dependency phase", () => {
    const args = sandboxArgs("/tmp/repo", "/opt/lrai-agent", true, ["--version"]);
    expect(args).toContain("--share-net");
    expect(args).toContain("/etc/ssl/certs");
    expect(args).toContain("--clearenv");
    expect(args).not.toContain("/home/luke");
  });

  it("keeps provider-native auth locations without leaking outer-worker secrets", () => {
    expect(providerEnvironment({
      HOME: "/var/lib/lrai-agent", PATH: "/opt/lrai-agent/bin:/usr/bin", CODEX_HOME: "/var/lib/lrai-agent/.codex",
      GITHUB_WEBHOOK_SECRET: "webhook-secret", LRAI_GITHUB_TOKEN: "installation-token",
      GIT_PASSWORD: "password", AWS_SECRET_ACCESS_KEY: "aws-secret", NPM_TOKEN: "npm-secret",
      LRAI_GITHUB_PRIVATE_KEY_PATH: "/etc/lrai-agent/key.pem",
    })).toEqual({ HOME: "/var/lib/lrai-agent", PATH: "/opt/lrai-agent/bin:/usr/bin", CODEX_HOME: "/var/lib/lrai-agent/.codex",
      npm_config_verify_deps_before_run: "false", npm_config_manage_package_manager_versions: "false" });
  });
});


describe("host-owned validation policy", () => {
  it("allows npm only for the authorized site identity and requires a real lockfile", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "validation-policy-"));
    try {
      await writeFile(path.join(workspace, "package.json"), JSON.stringify({
        name: "lukasijus/lukasrimkus_me", scripts: { typecheck: "tsc -b", build: "vite build" },
      }));
      await expect(validationPolicy(workspace, "someone/other")).rejects.toThrow("exact pnpm");
      await expect(validationPolicy(workspace, "lukasijus/lukasrimkus_me")).rejects.toThrow("package-lock.json");
      await symlink("package.json", path.join(workspace, "package-lock.json"));
      await expect(validationPolicy(workspace, "lukasijus/lukasrimkus_me")).rejects.toThrow("package-lock.json");
      await rm(path.join(workspace, "package-lock.json"));
      await writeFile(path.join(workspace, "package-lock.json"), "{}");
      await expect(validationPolicy(workspace, "lukasijus/lukasrimkus_me")).resolves.toMatchObject({
        projects: [{ manager: "npm", dir: "", packageManager: "npm@11.11.1", checks: ["typecheck", "build"] }],
      });
      await writeFile(path.join(workspace, "package.json"), JSON.stringify({ packageManager: "npm@99.0.0" }));
      await expect(validationPolicy(workspace, "lukasijus/lukasrimkus_me")).rejects.toThrow("npm@11.11.1");
      await writeFile(path.join(workspace, "package.json"), JSON.stringify({ packageManager: "pnpm@11.0.0", scripts: { test: "vitest" } }));
      await expect(validationPolicy(workspace, "lukasijus/calify")).resolves.toMatchObject({
        projects: [{ manager: "pnpm", checks: ["lint", "test", "build"] }],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses the host npm executable with the same isolated environment", () => {
    const args = sandboxArgs("/tmp/repo", "/opt/lrai-agent", false, ["--ignore-scripts", "run", "build"], "npm");
    expect(args.slice(-5)).toEqual(["--", "/opt/lrai-agent/bin/npm", "--ignore-scripts", "run", "build"]);
    expect(args).not.toContain("--share-net");
    expect(args).toContain("--clearenv");
  });
});

describe("IQPractice multi-project policy", () => {
  async function iqpractice(): Promise<string> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "validation-iq-"));
    for (const app of ["apps/web", "apps/mobile"]) {
      await mkdir(path.join(workspace, app), { recursive: true });
      await writeFile(path.join(workspace, app, "package.json"), JSON.stringify({ scripts: {} }));
      await writeFile(path.join(workspace, app, "package-lock.json"), "{}");
    }
    await mkdir(path.join(workspace, "tests/IQPractice.Domain.Tests"), { recursive: true });
    await writeFile(path.join(workspace, "IQPractice.slnx"), "<Solution />");
    await writeFile(path.join(workspace, "tests/IQPractice.Domain.Tests/IQPractice.Domain.Tests.csproj"), "<Project />");
    return workspace;
  }

  it("validates both npm apps and the .NET solution without a root package.json", async () => {
    const workspace = await iqpractice();
    try {
      const policy = await validationPolicy(workspace, "lukasijus/IQPractice");
      expect(policy.projects).toMatchObject([
        { kind: "node", manager: "npm", dir: "apps/web", checks: ["lint", "format:check", "test", "build"] },
        { kind: "node", manager: "npm", dir: "apps/mobile", checks: ["typecheck", "lint", "format:check", "test"] },
        { kind: "dotnet", dir: "", packageManager: "dotnet@10.0.403", solution: "IQPractice.slnx",
          tests: ["tests/IQPractice.Domain.Tests/IQPractice.Domain.Tests.csproj"] },
      ]);
      // The same tree under another identity still needs the default pnpm policy.
      await expect(validationPolicy(workspace, "someone/IQPractice")).rejects.toThrow("package.json");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("refuses symlinked app directories and missing lockfiles or solutions", async () => {
    const workspace = await iqpractice();
    try {
      await rm(path.join(workspace, "apps/mobile/package-lock.json"));
      await expect(validationPolicy(workspace, "lukasijus/IQPractice")).rejects.toThrow("apps/mobile/package-lock.json");
      await rm(path.join(workspace, "apps/mobile"), { recursive: true });
      await symlink("web", path.join(workspace, "apps/mobile"));
      await expect(validationPolicy(workspace, "lukasijus/IQPractice")).rejects.toThrow("regular directory at apps/mobile");
      await rm(path.join(workspace, "apps/mobile"));
      await mkdir(path.join(workspace, "apps/mobile"));
      await writeFile(path.join(workspace, "apps/mobile/package.json"), "{}");
      await writeFile(path.join(workspace, "apps/mobile/package-lock.json"), "{}");
      await rm(path.join(workspace, "IQPractice.slnx"));
      await expect(validationPolicy(workspace, "lukasijus/IQPractice")).rejects.toThrow("IQPractice.slnx");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("runs dotnet from the host toolchain with a task-local package cache", () => {
    const args = sandboxArgs("/tmp/repo", "/opt/lrai-agent", false, ["build", "IQPractice.slnx"], "dotnet");
    expect(args.slice(-4)).toEqual(["--", "/opt/lrai-agent/bin/dotnet", "build", "IQPractice.slnx"]);
    const env = (name: string) => args[args.indexOf(name) + 1];
    expect(env("DOTNET_ROOT")).toBe("/opt/lrai-agent/dotnet");
    expect(env("NUGET_PACKAGES")).toBe(path.join("/tmp/repo", NUGET_DIRECTORY));
    expect(env("DOTNET_CLI_TELEMETRY_OPTOUT")).toBe("1");
    // A synthetic one-line passwd, never the host's /etc.
    expect(args.slice(args.indexOf("/etc/passwd") - 2, args.indexOf("/etc/passwd") + 1))
      .toEqual(["--ro-bind", path.join("/tmp/repo", PASSWD_FILE), "/etc/passwd"]);
    expect(args).not.toContain("/etc");
    expect(args).toContain("--clearenv");
    expect(args).not.toContain("--share-net");
    expect(args).not.toContain("/home/luke");
  });

  it("runs app checks from their directory without widening the mounted workspace", () => {
    const args = sandboxArgs("/tmp/repo", "/opt/lrai-agent", false, ["run", "lint"], "npm", "/tmp/repo/apps/web");
    expect(args.slice(args.indexOf("--bind"), args.indexOf("--bind") + 5))
      .toEqual(["--bind", "/tmp/repo", "/tmp/repo", "--chdir", "/tmp/repo/apps/web"]);
    expect(args).not.toContain("DOTNET_ROOT");
    expect(args).not.toContain("/etc/passwd");
  });
});
