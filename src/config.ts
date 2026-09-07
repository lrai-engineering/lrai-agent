import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { AgentConfig, LoadedConfig, ProviderName } from "./types.js";

const DEFAULT_CONFIG: AgentConfig = {
  version: 1,
  provider: "codex",
  plan: { prompt: "prompts/plan.md" },
  implement: { prompt: "prompts/implement.md" },
  providers: {
    codex: {
      executable: "codex",
      model: "gpt-6-astra",
      reasoningEffort: "medium",
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
  assertKnownKeys(
    raw,
    ["version", "provider", "plan", "implement", "providers", "preview"],
    "config",
  );
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error("configuration version must be 1");
  }

  const plan = raw.plan === undefined ? {} : raw.plan;
  const implement = raw.implement === undefined ? {} : raw.implement;
  const providers = raw.providers === undefined ? {} : raw.providers;
  const preview = raw.preview === undefined ? undefined : raw.preview;
  if (!isRecord(plan)) throw new Error("plan must be an object");
  if (!isRecord(implement)) throw new Error("implement must be an object");
  if (!isRecord(providers)) throw new Error("providers must be an object");
  if (preview !== undefined && !isRecord(preview)) throw new Error("preview must be an object");
  assertKnownKeys(plan, ["prompt"], "plan");
  assertKnownKeys(implement, ["prompt"], "implement");
  assertKnownKeys(providers, ["codex", "claude"], "providers");
  if (preview !== undefined) assertKnownKeys(preview, ["app"], "preview");

  const codex = providers.codex === undefined ? {} : providers.codex;
  const claude = providers.claude === undefined ? {} : providers.claude;
  if (!isRecord(codex)) throw new Error("providers.codex must be an object");
  if (!isRecord(claude)) throw new Error("providers.claude must be an object");
  assertKnownKeys(codex, ["executable", "model", "reasoningEffort"], "providers.codex");
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
  const codexModel = optionalString(codex.model, "providers.codex.model") ?? DEFAULT_CONFIG.providers.codex.model;
  const codexReasoningEffort = enumValue(
    codex.reasoningEffort,
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
    "providers.codex.reasoningEffort",
  ) ?? DEFAULT_CONFIG.providers.codex.reasoningEffort;
  const claudeModel = optionalString(claude.model, "providers.claude.model");
  const previewApp = preview === undefined ? undefined : optionalString(preview.app, "preview.app");
  if (previewApp !== undefined && !/^[a-z][a-z0-9-]{0,38}$/.test(previewApp)) {
    throw new Error("preview.app must be a lowercase URL-safe application name");
  }

  return {
    version: 1,
    provider: provider ?? DEFAULT_CONFIG.provider,
    plan: {
      prompt:
        optionalString(plan.prompt, "plan.prompt") ?? DEFAULT_CONFIG.plan.prompt,
    },
    implement: {
      prompt:
        optionalString(implement.prompt, "implement.prompt") ??
        DEFAULT_CONFIG.implement.prompt,
    },
    providers: {
      codex: {
        executable:
          optionalString(codex.executable, "providers.codex.executable") ??
          DEFAULT_CONFIG.providers.codex.executable,
        ...(codexModel === undefined ? {} : { model: codexModel }),
        ...(codexReasoningEffort === undefined ? {} : { reasoningEffort: codexReasoningEffort }),
      },
      claude: {
        executable:
          optionalString(claude.executable, "providers.claude.executable") ??
          DEFAULT_CONFIG.providers.claude.executable,
        ...(claudeModel === undefined ? {} : { model: claudeModel }),
      },
    },
    ...(previewApp === undefined ? {} : { preview: { app: previewApp } }),
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
    const configDirectory = path.dirname(configPath);
    const promptDirectories = isRecord(raw)
      ? {
          ...(isRecord(raw.plan) && typeof raw.plan.prompt === "string"
            ? { plan: configDirectory }
            : {}),
          ...(isRecord(raw.implement) &&
          typeof raw.implement.prompt === "string"
            ? { implement: configDirectory }
            : {}),
        }
      : {};
    return {
      config: mergeConfig(raw, explicitPath !== undefined),
      ...(Object.keys(promptDirectories).length === 0
        ? {}
        : { promptDirectories }),
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
