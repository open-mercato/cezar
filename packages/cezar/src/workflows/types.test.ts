import { describe, expect, it } from 'vitest';
import { skillStackOf, workflowFileSchema } from './types.ts';

describe('workflow reasoning effort', () => {
  it('parses a per-step reasoning effort from YAML-shaped workflow data', () => {
    const parsed = workflowFileSchema.parse({
      name: 'careful-implementation',
      steps: [{ id: 'implement', prompt: '{{task}}', reasoningEffort: 'high' }],
    });
    expect(parsed.steps?.[0]?.reasoningEffort).toBe('high');
  });

  it('does not serialize an effort-bearing step as the portable skills shorthand', () => {
    expect(skillStackOf([{ id: 'implement', skill: 'implement', prompt: '{{task}}', reasoningEffort: 'high' }])).toBeNull();
  });
});
