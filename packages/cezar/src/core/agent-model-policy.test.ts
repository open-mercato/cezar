import { describe, expect, it } from 'vitest';
import { agentModelsLocked } from './agent-model-policy.js';

describe('agentModelsLocked', () => {
  it('is off by default and only exact 1 enables it', () => {
    expect(agentModelsLocked({})).toBe(false);
    expect(agentModelsLocked({ CEZ_AGENT_MODELS_LOCKED: '0' })).toBe(false);
    expect(agentModelsLocked({ CEZ_AGENT_MODELS_LOCKED: 'true' })).toBe(false);
    expect(agentModelsLocked({ CEZ_AGENT_MODELS_LOCKED: '1' })).toBe(true);
  });
});
