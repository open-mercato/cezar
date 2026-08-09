import { describe, expect, it } from 'vitest';
import {
  continueRunInputSchema,
  createRunInputSchema,
  startTodoInputSchema,
  workflowStepDefSchema,
} from '@open-mercato/cezar-contract';

describe('reasoning effort request contract', () => {
  it('accepts a discovered per-run effort on every run-start entry point', () => {
    expect(createRunInputSchema.parse({ workflow: 'quick-task', task: 'Implement it', reasoningEffort: 'high' }))
      .toMatchObject({ reasoningEffort: 'high' });
    expect(continueRunInputSchema.parse({ reasoningEffort: 'medium' })).toMatchObject({ reasoningEffort: 'medium' });
    expect(startTodoInputSchema.parse({ reasoningEffort: 'low' })).toMatchObject({ reasoningEffort: 'low' });
  });

  it('keeps native defaults representable by omitting effort, and rejects a blank value', () => {
    expect(continueRunInputSchema.parse({}).reasoningEffort).toBeUndefined();
    expect(startTodoInputSchema.parse(undefined)).toBeUndefined();
    expect(continueRunInputSchema.safeParse({ reasoningEffort: '  ' }).success).toBe(false);
  });

  it('accepts an effort for an individual workflow step', () => {
    expect(
      workflowStepDefSchema.parse({ id: 'implement', prompt: '{{task}}', reasoningEffort: 'xhigh' }),
    ).toMatchObject({ reasoningEffort: 'xhigh' });
  });
});
