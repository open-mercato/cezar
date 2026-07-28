/** The server-side switch that makes native agent settings authoritative. */
export const AGENT_MODELS_LOCKED_ENV = 'CEZ_AGENT_MODELS_LOCKED';

/** Only the exact value `1` enables the lock; unset keeps the current behavior. */
export function agentModelsLocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENT_MODELS_LOCKED_ENV] === '1';
}

export const AGENT_MODELS_LOCKED_ERROR =
  'agent models are locked — configure the model in the native coding-agent settings';
