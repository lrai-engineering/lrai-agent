import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { AgentConfig, LoadedConfig, ProviderName } from "./types.js";

const DEFAULT_CONFIG: AgentConfig = {
  version: 1,
  provider: "codex",
  plan: { prompt: "prompts/plan.md" },
  providers: {
    codex: {
      executable: "codex",
    },
    claude: {
      executable: "claude",
    },
  },
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${field} contains unknown setting(s): ${unknown.join(", ")}`);
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function mergeConfig(raw: unknown, allowExecutableOverride: boolean): AgentConfig {
  if (!isRecord(raw)) throw new Error("configuration must be a YAML object");
  assertKnownKeys(raw, ["version", "provider", "plan", "providers"], "config");
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error("configuration version must be 1");
  }

  const plan = raw.plan === undefined ? {} : raw.plan;
  const providers = raw.providers === undefined ? {} : raw.providers;
  if (!isRecord(plan)) throw new Error("plan must be an object");
  if (!isRecord(providers)) throw new Error("providers must be an object");
  assertKnownKeys(plan, ["prompt"], "plan");
  assertKnownKeys(providers, ["codex", "claude"], "providers");

  const codex = providers.codex === undefined ? {} : providers.codex;
  const claude = providers.claude === undefined ? {} : providers.claude;
  if (!isRecord(codex)) throw new Error("providers.codex must be an object");
  if (!isRecord(claude)) throw new Error("providers.claude must be an object");
  assertKnownKeys(codex, ["executable", "model"], "providers.codex");
  assertKnownKeys(claude, ["executable", "model"], "providers.claude");
  if (
    !allowExecutableOverride &&
    (codex.executable !== undefined || claude.executable !== undefined)
  ) {
    throw new Error(
      "provider executables are worker settings; configure them through LRAI_CONFIG",
    );
  }

  const provider = enumValue(
    raw.provider,
    ["codex", "claude"] as const,
    "provider",
  );
  const codexModel = optionalString(codex.model, "providers.codex.model");
  const claudeModel = optionalString(claude.model, "providers.claude.model");

  return {
    version: 1,
    provider: provider ?? DEFAULT_CONFIG.provider,
    plan: {
      prompt:
        optionalString(plan.prompt, "plan.prompt") ?? DEFAULT_CONFIG.plan.prompt,
    },
    providers: {
      codex: {
        executable:
          optionalString(codex.executable, "providers.codex.executable") ??
          DEFAULT_CONFIG.providers.codex.executable,
        ...(codexModel === undefined ? {} : { model: codexModel }),
      },
      claude: {
        executable:
          optionalString(claude.executable, "providers.claude.executable") ??
          DEFAULT_CONFIG.providers.claude.executable,
        ...(claudeModel === undefined ? {} : { model: claudeModel }),
      },
    },
  };
}

export async function loadConfig(
  workingDirectory: string,
  explicitPath = process.env.LRAI_CONFIG,
): Promise<LoadedConfig> {
  const configPath = explicitPath
    ? path.resolve(workingDirectory, explicitPath)
    : path.join(workingDirectory, ".lrai-agent.yml");

  try {
    const contents = await readFile(configPath, "utf8");
    const raw = parse(contents);
    const hasRepositoryPrompt =
      isRecord(raw) &&
      isRecord(raw.plan) &&
      typeof raw.plan.prompt === "string";
    return {
      config: mergeConfig(raw, explicitPath !== undefined),
      ...(hasRepositoryPrompt
        ? { configDirectory: path.dirname(configPath) }
        : {}),
    };
  } catch (error) {
    if (
      !explicitPath &&
      isRecord(error) &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { config: DEFAULT_CONFIG };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to load ${configPath}: ${message}`);
  }
}

export function selectProvider(
  configured: ProviderName,
  override?: string,
): ProviderName {
  if (override === undefined) return configured;
  if (override !== "codex" && override !== "claude") {
    throw new Error("provider must be codex or claude");
  }
  return override;
}
