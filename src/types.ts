export type ProviderName = "codex" | "claude";
export type AgentCommand = "plan" | "implement";
export type WebhookCommand = AgentCommand | "deploy" | "unknown";

export interface TaskAttachment {
  sourceUrl: string;
  path: string;
  mediaType: string;
  size: number;
  kind: "image" | "text" | "pdf";
}

export interface TaskContext {
  repository: string;
  issueNumber?: string;
  title: string;
  body: string;
  sender: string;
  workingDirectory: string;
  attachments?: TaskAttachment[];
}

export interface CodexConfig {
  executable: string;
  model?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ClaudeConfig {
  executable: string;
  model?: string;
}

export interface AgentConfig {
  version: 1;
  provider: ProviderName;
  plan: {
    prompt: string;
  };
  implement: {
    prompt: string;
  };
  providers: {
    codex: CodexConfig;
    claude: ClaudeConfig;
  };
  preview?: {
    app: string;
  };
}

export interface LoadedConfig {
  config: AgentConfig;
  promptDirectories?: Partial<Record<AgentCommand, string>>;
}

export interface Invocation {
  executable: string;
  args: string[];
  cwd: string;
  stdin: string;
}

export interface WebhookTask {
  delivery: string;
  event: string;
  command: string;
  repository?: string;
  defaultBranch?: string;
  issueNumber?: number;
  title?: string;
  body?: string;
  sender?: string;
  installationId?: number;
  deployPreview?: boolean;
  consumeLabels?: string[];
}
