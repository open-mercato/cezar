import type { RunnerId } from '../../core/agent-runner.ts';

export interface AgentModelSettings {
  model?: string;
  provider?: string;
}

export interface AgentModelSettingsStrategy {
  readonly runner: RunnerId;
  read(repoRoot: string, env: NodeJS.ProcessEnv): Promise<AgentModelSettings>;
}
