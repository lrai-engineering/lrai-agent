export type ProviderName = "codex" | "claude";

export interface TaskContext {
  repository: string;
  issueNumber?: string;
  title: string;
  body: string;
  sender: string;
  workingDirectory: string;
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
  providers: {
    codex: CodexConfig;
    claude: ClaudeConfig;
  };
}

export interface LoadedConfig {
  config: AgentConfig;
  configDirectory?: string;
}

export interface Invocation {
  executable: string;
  args: string[];
  cwd: string;
  stdin: string;
}
