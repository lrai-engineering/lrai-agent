import { execFile } from "node:child_process";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TIMEOUT = 10 * 60_000;

// Host-owned policy: repository content never supplies an executable or a shell
// command to the outer worker. Package scripts run only in the offline sandbox.
export function sandboxArgs(workspace: string, toolchain: string, network: boolean, args: string[]): string[] {
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
    "--", `${toolchain}/bin/pnpm`, ...args,
  ];
}

async function manifest(workspace: string): Promise<{ packageManager: string; scripts: Record<string, string> }> {
  const filename = path.join(workspace, "package.json");
  const info = await lstat(filename).catch(() => undefined);
  if (!info?.isFile()) throw new Error("Worker validation currently requires a regular package.json with a pinned pnpm packageManager");
  const value = JSON.parse(await readFile(filename, "utf8"));
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(value.packageManager ?? "")) {
    throw new Error("Worker validation requires an exact pnpm packageManager version; other package managers need a host-owned validation policy");
  }
  return { packageManager: value.packageManager, scripts: value.scripts ?? {} };
}

async function run(workspace: string, network: boolean, args: string[]): Promise<string> {
  const toolchain = await realpath(process.env.LRAI_WORKER_TOOLCHAIN ?? "/opt/lrai-agent");
  await access(path.join(toolchain, "bin/pnpm"));
  try {
    const result = await exec("/usr/bin/bwrap", sandboxArgs(workspace, toolchain, network, args), {
      cwd: workspace, env: {}, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`Sandboxed pnpm ${args.join(" ")} failed: ${(failure.stderr || failure.stdout || failure.message).slice(-6000)}`);
  }
}

export async function prepareWorkspace(workspace: string, repairLockfile = false): Promise<void> {
  const pkg = await manifest(workspace);
  const version = (await run(workspace, false, ["--version"])).trim();
  if (`pnpm@${version}` !== pkg.packageManager) {
    throw new Error(`Worker has pnpm@${version}, repository requires ${pkg.packageManager}; update the host toolchain explicitly`);
  }
  // No hooks, lifecycle scripts, automatic manager downloads, or inherited npm
  // credentials while networking is enabled. The provider itself stays offline.
  await run(workspace, true, ["install", repairLockfile ? "--no-frozen-lockfile" : "--frozen-lockfile",
    "--ignore-scripts", "--ignore-pnpmfile", "--config.manage-package-manager-versions=false",
    "--store-dir", "/tmp/pnpm-store"]);
}

export async function validateWorkspace(workspace: string): Promise<string> {
  const pkg = await manifest(workspace);
  if (!pkg.scripts.lint || !pkg.scripts.build) {
    throw new Error("Worker validation requires lint and build scripts; configure a host-owned policy for other projects");
  }
  const checks = ["lint", ...(pkg.scripts.test ? ["test"] : []), "build"];
  // pnpm 11 otherwise attempts an implicit network install before scripts when
  // its ephemeral store differs. Installation was explicitly verified above.
  for (const check of checks) await run(workspace, false, ["--config.verify-deps-before-run=false", "run", check]);
  return `Passed frozen dependency installation and offline ${checks.join(", ")} checks. Specialty/browser checks are separate.`;
}
