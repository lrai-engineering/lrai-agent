import { execFile } from "node:child_process";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TIMEOUT = 10 * 60_000;

// Host-owned policy: repository content never supplies an executable or a shell
// command to the outer worker. Package scripts run only in the offline sandbox.
export function sandboxArgs(workspace: string, toolchain: string, network: boolean, args: string[], manager: "pnpm" | "npm" = "pnpm"): string[] {
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
    "--bind", workspace, workspace, "--chdir", workspace,
    "--dir", "/tmp/home", "--clearenv",
    "--setenv", "HOME", "/tmp/home",
    "--setenv", "PATH", `${toolchain}/bin:/usr/bin:/bin`,
    "--setenv", "CI", "true",
    "--setenv", "NEXT_TELEMETRY_DISABLED", "1",
    "--setenv", "npm_config_userconfig", "/dev/null",
    "--setenv", "npm_config_manage_package_manager_versions", "false",
    "--setenv", "npm_config_store_dir", "/tmp/pnpm-store",
    "--setenv", "COREPACK_ENABLE_PROJECT_SPEC", "0",
    "--", `${toolchain}/bin/${manager}`, ...args,
  ];
}

export async function validationPolicy(workspace: string, repository?: string): Promise<{
  manager: "pnpm" | "npm"; packageManager: string; scripts: Record<string, string>; checks: string[];
}> {
  const filename = path.join(workspace, "package.json");
  const info = await lstat(filename).catch(() => undefined);
  if (!info?.isFile()) throw new Error("Worker validation currently requires a regular package.json with a pinned pnpm packageManager");
  const value = JSON.parse(await readFile(filename, "utf8"));
  // Repository identity comes from the authorized webhook task, never package.json.
  if (repository === "lukasijus/lukasrimkus_me") {
    const lock = await lstat(path.join(workspace, "package-lock.json")).catch(() => undefined);
    if (!lock?.isFile()) throw new Error("npm validation requires a regular package-lock.json");
    if (value.packageManager && value.packageManager !== "npm@11.11.1") {
      throw new Error("Host npm policy requires npm@11.11.1");
    }
    return { manager: "npm", packageManager: "npm@11.11.1", scripts: value.scripts ?? {}, checks: ["typecheck", "build"] };
  }
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(value.packageManager ?? "")) {
    throw new Error("Worker validation requires an exact pnpm packageManager version; other package managers need a host-owned validation policy");
  }
  return { manager: "pnpm", packageManager: value.packageManager, scripts: value.scripts ?? {}, checks: ["lint", ...(value.scripts?.test ? ["test"] : []), "build"] };
}

async function run(workspace: string, network: boolean, args: string[], manager: "pnpm" | "npm"): Promise<string> {
  const toolchain = await realpath(process.env.LRAI_WORKER_TOOLCHAIN ?? "/opt/lrai-agent");
  await access(path.join(toolchain, `bin/${manager}`));
  try {
    const result = await exec("/usr/bin/bwrap", sandboxArgs(workspace, toolchain, network, args, manager), {
      cwd: workspace, env: {}, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`Sandboxed ${manager} ${args.join(" ")} failed: ${(failure.stderr || failure.stdout || failure.message).slice(-6000)}`);
  }
}

export async function prepareWorkspace(workspace: string, repairLockfile = false, repository?: string): Promise<void> {
  const pkg = await validationPolicy(workspace, repository);
  const version = (await run(workspace, false, ["--version"], pkg.manager)).trim();
  if (`${pkg.manager}@${version}` !== pkg.packageManager) {
    throw new Error(`Worker has ${pkg.manager}@${version}, repository requires ${pkg.packageManager}; update the host toolchain explicitly`);
  }
  // No hooks, lifecycle scripts, automatic manager downloads, or inherited npm
  // credentials while networking is enabled. The provider itself stays offline.
  if (pkg.manager === "npm") {
    if (repairLockfile) {
      await run(workspace, true, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], "npm");
    }
    await run(workspace, true, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], "npm");
    return;
  }
  await run(workspace, true, ["install", repairLockfile ? "--no-frozen-lockfile" : "--frozen-lockfile",
    "--ignore-scripts", "--ignore-pnpmfile", "--config.manage-package-manager-versions=false",
    "--store-dir", "/tmp/pnpm-store"], "pnpm");
}

export async function validateWorkspace(workspace: string, repository?: string): Promise<string> {
  const pkg = await validationPolicy(workspace, repository);
  const checks = pkg.checks;
  if (checks.some((check) => !pkg.scripts[check])) {
    throw new Error(`Worker validation requires ${checks.join(" and ")} scripts for this host-owned policy`);
  }
  // pnpm 11 otherwise attempts an implicit network install before scripts when
  // its ephemeral store differs. Installation was explicitly verified above.
  for (const check of checks) {
    const args = pkg.manager === "pnpm"
      ? ["--config.verify-deps-before-run=false", "run", check]
      : ["--ignore-scripts", "run", check];
    await run(workspace, false, args, pkg.manager);
  }
  return `Passed frozen dependency installation and offline ${checks.join(", ")} checks. Specialty/browser checks are separate.`;
}
