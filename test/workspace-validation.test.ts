import { describe, expect, it } from "vitest";
import { sandboxArgs } from "../src/workspace-validation.js";
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
