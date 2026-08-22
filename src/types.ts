export type ProviderName = "codex" | "claude";
export type AgentCommand = "plan" | "implement";

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
