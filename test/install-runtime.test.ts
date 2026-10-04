import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const installer = path.resolve("scripts/install-runtime.sh");

describe("initial runtime installer", () => {
  it("provides help without sudo or host changes", () => {
    const output = execFileSync("/bin/bash", [installer, "--help"], {
      env: { PATH: "/usr/bin:/bin" }, encoding: "utf8",
    });
    expect(output).toContain("No services are installed");
  });

  // A root test runner is intentionally refused by the installer before sudo.
  it.skipIf(process.getuid?.() === 0)("refuses an existing runtime before building or changing the host", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "lrai-installer-test-"));
    try {
      const log = path.join(fixture, "calls");
      writeFileSync(path.join(fixture, "sudo"), `#!/bin/bash
printf '%s\\n' "$*" >> "$INSTALLER_TEST_LOG"
case "$1" in
  true) exit 0 ;;
  test) exit 0 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
      writeFileSync(path.join(fixture, "npm"), "#!/bin/bash\nexit 98\n", { mode: 0o755 });
      const result = spawnSync("/bin/bash", [installer], {
        env: { ...process.env, PATH: `${fixture}:${process.env.PATH}`, INSTALLER_TEST_LOG: log },
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Existing runtime detected");
      expect(readFileSync(log, "utf8")).toBe("true\ntest -e /opt/lrai-agent/bin/node\n");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.getuid?.() === 0)("stops before host mutations when validation fails", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "lrai-installer-test-"));
    try {
      const log = path.join(fixture, "calls");
      writeFileSync(path.join(fixture, "sudo"), `#!/bin/bash
printf '%s\\n' "$*" >> "$INSTALLER_TEST_LOG"
case "$1" in
  true) exit 0 ;;
  test) exit 1 ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
      writeFileSync(path.join(fixture, "npm"), `#!/bin/bash
if [[ "$1" == ci ]]; then exit 0; fi
echo 'validation failed' >&2
exit 42
`, { mode: 0o755 });
      const result = spawnSync("/bin/bash", [installer], {
        env: { ...process.env, PATH: `${fixture}:${process.env.PATH}`, INSTALLER_TEST_LOG: log },
        encoding: "utf8",
      });
      expect(result.status).toBe(42);
      expect(result.stderr).toContain("validation failed");
      expect(readFileSync(log, "utf8")).toBe(
        "true\ntest -e /opt/lrai-agent/bin/node\ntest -e /opt/lrai-agent/lib/node_modules/@lrai-engineering/lrai-agent\n",
      );
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});
