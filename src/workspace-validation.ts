import { execFile } from "node:child_process";
import { access, lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TIMEOUT = 10 * 60_000;

export type Manager = "pnpm" | "npm" | "dotnet";

const HOST_NPM = "npm@11.11.1";
// The .NET SDK installed at <toolchain>/dotnet (deploy/jetson/install-dotnet-toolchain.sh).
const HOST_DOTNET = "dotnet@10.0.403";

// NuGet packages live inside .git: they survive between sandbox runs of one
// task, are removed with the workspace, and can never be staged by `git add`.
export const NUGET_DIRECTORY = ".git/lrai-nuget";
// .NET blocks indefinitely looking up the current user when /etc/passwd is
// absent. The sandbox gets a one-line file instead of the host's user list.
export const PASSWD_FILE = ".git/lrai-passwd";

export interface NodeProject {
  kind: "node";
  manager: "pnpm" | "npm";
  /** Directory relative to the workspace root; "" is the root. */
  dir: string;
  packageManager: string;
  scripts: Record<string, string>;
  checks: string[];
}

export interface DotnetProject {
  kind: "dotnet";
  manager: "dotnet";
  dir: string;
  packageManager: string;
  /** Solution or project passed to restore/build/format. */
  solution: string;
  /** Test projects run without network; tests needing Docker are excluded by policy. */
  tests: string[];
}

export type ValidationProject = NodeProject | DotnetProject;

export interface ValidationPolicy {
  projects: ValidationProject[];
}

// Host-owned policy: repository content never supplies an executable or a shell
// command to the outer worker. Package scripts run only in the offline sandbox.
export function sandboxArgs(
  workspace: string, toolchain: string, network: boolean, args: string[],
  manager: Manager = "pnpm", cwd: string = workspace,
): string[] {
  return [
    "--die-with-parent", "--new-session", "--unshare-all",
    ...(network ? ["--share-net"] : []),
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind", toolchain, toolchain,
    ...(network ? [
      "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
      "--ro-bind", "/etc/hosts", "/etc/hosts",
      "--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs",
    ] : []),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--bind", workspace, workspace,
    ...(manager === "dotnet" ? ["--ro-bind", path.join(workspace, PASSWD_FILE), "/etc/passwd"] : []),
    "--chdir", cwd,
    "--dir", "/tmp/home", "--clearenv",
    "--setenv", "HOME", "/tmp/home",
    "--setenv", "PATH", `${toolchain}/bin:/usr/bin:/bin`,
    "--setenv", "CI", "true",
    "--setenv", "NEXT_TELEMETRY_DISABLED", "1",
    "--setenv", "npm_config_userconfig", "/dev/null",
    "--setenv", "npm_config_manage_package_manager_versions", "false",
    "--setenv", "npm_config_store_dir", "/tmp/pnpm-store",
    "--setenv", "COREPACK_ENABLE_PROJECT_SPEC", "0",
    ...(manager === "dotnet" ? [
      "--setenv", "DOTNET_ROOT", `${toolchain}/dotnet`,
      "--setenv", "DOTNET_CLI_HOME", "/tmp/home",
      "--setenv", "DOTNET_NOLOGO", "1",
      "--setenv", "DOTNET_CLI_TELEMETRY_OPTOUT", "1",
      "--setenv", "DOTNET_SKIP_FIRST_TIME_EXPERIENCE", "1",
      "--setenv", "DOTNET_GENERATE_ASPNET_CERTIFICATE", "false",
      "--setenv", "DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE", "1",
      "--setenv", "MSBUILDDISABLENODEREUSE", "1",
      "--setenv", "NUGET_PACKAGES", path.join(workspace, NUGET_DIRECTORY),
    ] : []),
    "--", `${toolchain}/bin/${manager}`, ...args,
  ];
}

async function regularFile(filename: string): Promise<boolean> {
  return (await lstat(filename).catch(() => undefined))?.isFile() ?? false;
}

async function projectDirectory(workspace: string, dir: string): Promise<string> {
  // Each path segment must be a real directory: a symlinked app directory could
  // otherwise point the policy at different content than the reviewed tree.
  let current = workspace;
  for (const segment of dir.split("/").filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => undefined);
    if (!info?.isDirectory()) throw new Error(`Validation policy requires a regular directory at ${dir}`);
  }
  return current;
}

async function readPackage(workspace: string, dir: string): Promise<Record<string, any>> {
  const filename = path.join(await projectDirectory(workspace, dir), "package.json");
  if (!await regularFile(filename)) {
    throw new Error(dir
      ? `Validation policy requires a regular ${dir}/package.json`
      : "Worker validation currently requires a regular package.json with a pinned pnpm packageManager");
  }
  return JSON.parse(await readFile(filename, "utf8"));
}

async function npmProject(workspace: string, dir: string, checks: string[]): Promise<NodeProject> {
  const value = await readPackage(workspace, dir);
  const lock = path.join(workspace, dir, "package-lock.json");
  if (!await regularFile(lock)) {
    throw new Error(`npm validation requires a regular ${dir ? `${dir}/` : ""}package-lock.json`);
  }
  if (value.packageManager && value.packageManager !== HOST_NPM) {
    throw new Error(`Host npm policy requires ${HOST_NPM}`);
  }
  return { kind: "node", manager: "npm", dir, packageManager: HOST_NPM, scripts: value.scripts ?? {}, checks };
}

async function dotnetProject(workspace: string, dir: string, solution: string, tests: string[]): Promise<DotnetProject> {
  const root = await projectDirectory(workspace, dir);
  for (const file of [solution, ...tests]) {
    if (!await regularFile(path.join(root, file))) throw new Error(`.NET validation requires a regular ${path.join(dir, file)}`);
  }
  return { kind: "dotnet", manager: "dotnet", dir, packageManager: HOST_DOTNET, solution, tests };
}

export async function validationPolicy(workspace: string, repository?: string): Promise<ValidationPolicy> {
  // Repository identity comes from the authorized webhook task, never package.json.
  if (repository === "lukasijus/lukasrimkus_me") {
    return { projects: [await npmProject(workspace, "", ["typecheck", "build"])] };
  }
  if (repository === "lukasijus/IQPractice") {
    // A .NET API plus two npm apps, with no root package.json. The API
    // integration tests need Docker (Testcontainers) and stay out of the sandbox.
    return {
      projects: [
        await npmProject(workspace, "apps/web", ["lint", "format:check", "test", "build"]),
        await npmProject(workspace, "apps/mobile", ["typecheck", "lint", "format:check", "test"]),
        await dotnetProject(workspace, "", "IQPractice.slnx", ["tests/IQPractice.Domain.Tests/IQPractice.Domain.Tests.csproj"]),
      ],
    };
  }
  const value = await readPackage(workspace, "");
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(value.packageManager ?? "")) {
    throw new Error("Worker validation requires an exact pnpm packageManager version; other package managers need a host-owned validation policy");
  }
  return {
    projects: [{
      kind: "node", manager: "pnpm", dir: "", packageManager: value.packageManager, scripts: value.scripts ?? {},
      checks: ["lint", ...(value.scripts?.test ? ["test"] : []), "build"],
    }],
  };
}

function label(project: ValidationProject): string {
  return project.kind === "dotnet" ? path.join(project.dir, project.solution) : project.dir || ".";
}

async function run(workspace: string, network: boolean, args: string[], manager: Manager, dir = ""): Promise<string> {
  const toolchain = await realpath(process.env.LRAI_WORKER_TOOLCHAIN ?? "/opt/lrai-agent");
  await access(path.join(toolchain, `bin/${manager}`));
  const cwd = path.join(workspace, dir);
  if (manager === "dotnet") {
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    await writeFile(path.join(workspace, PASSWD_FILE), `sandbox:x:${uid}:${gid}:sandbox:/tmp/home:/bin/false\n`);
  }
  try {
    const result = await exec("/usr/bin/bwrap", sandboxArgs(workspace, toolchain, network, args, manager, cwd), {
      cwd: workspace, env: {}, timeout: TIMEOUT, maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const where = dir ? ` (in ${dir})` : "";
    throw new Error(`Sandboxed ${manager} ${args.join(" ")}${where} failed: ${(failure.stderr || failure.stdout || failure.message).slice(-6000)}`);
  }
}

async function prepareProject(workspace: string, project: ValidationProject, repairLockfile: boolean): Promise<void> {
  const version = (await run(workspace, false, ["--version"], project.manager, project.dir)).trim();
  if (`${project.manager}@${version}` !== project.packageManager) {
    throw new Error(`Worker has ${project.manager}@${version}, repository requires ${project.packageManager}; update the host toolchain explicitly`);
  }
  // No hooks, lifecycle scripts, automatic manager downloads, or inherited npm
  // credentials while networking is enabled. The provider itself stays offline.
  if (project.kind === "dotnet") {
    // Restore downloads packages only; MSBuild targets run later, offline.
    await run(workspace, true, ["restore", project.solution, "--disable-build-servers"], "dotnet", project.dir);
    return;
  }
  if (project.manager === "npm") {
    if (repairLockfile) {
      await run(workspace, true, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], "npm", project.dir);
    }
    await run(workspace, true, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], "npm", project.dir);
    return;
  }
  await run(workspace, true, ["install", repairLockfile ? "--no-frozen-lockfile" : "--frozen-lockfile",
    "--ignore-scripts", "--ignore-pnpmfile", "--config.manage-package-manager-versions=false",
    "--store-dir", "/tmp/pnpm-store"], "pnpm", project.dir);
}

export async function prepareWorkspace(workspace: string, repairLockfile = false, repository?: string): Promise<void> {
  const policy = await validationPolicy(workspace, repository);
  for (const project of policy.projects) await prepareProject(workspace, project, repairLockfile);
}

async function validateProject(workspace: string, project: ValidationProject): Promise<string[]> {
  if (project.kind === "dotnet") {
    const common = ["--no-restore", "--disable-build-servers"];
    await run(workspace, false, ["build", project.solution, ...common], "dotnet", project.dir);
    await run(workspace, false, ["format", project.solution, "--verify-no-changes", "--no-restore"], "dotnet", project.dir);
    for (const test of project.tests) {
      await run(workspace, false, ["test", test, "--no-build", "--disable-build-servers"], "dotnet", project.dir);
    }
    return ["dotnet build", "dotnet format", ...project.tests.map((test) => `dotnet test ${path.basename(test, ".csproj")}`)];
  }
  const missing = project.checks.filter((check) => !project.scripts[check]);
  if (missing.length > 0) {
    throw new Error(`Worker validation requires ${project.checks.join(" and ")} scripts in ${label(project)} for this host-owned policy`);
  }
  // pnpm 11 otherwise attempts an implicit network install before scripts when
  // its ephemeral store differs. Installation was explicitly verified above.
  for (const check of project.checks) {
    const args = project.manager === "pnpm"
      ? ["--config.verify-deps-before-run=false", "run", check]
      : ["--ignore-scripts", "run", check];
    await run(workspace, false, args, project.manager, project.dir);
  }
  return project.checks;
}

export async function validateWorkspace(workspace: string, repository?: string): Promise<string> {
  const policy = await validationPolicy(workspace, repository);
  const passed: string[] = [];
  for (const project of policy.projects) {
    const checks = await validateProject(workspace, project);
    passed.push(policy.projects.length === 1 ? checks.join(", ") : `${label(project)}: ${checks.join(", ")}`);
  }
  return `Passed frozen dependency installation and offline ${passed.join("; ")} checks. Specialty/browser checks are separate.`;
}
