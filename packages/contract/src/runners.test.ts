import { describe, expect, it } from 'vitest';
import { perRunner, RUNNER_IDS } from './runners.ts';
import { z } from 'zod';

describe('perRunner', () => {
  const schema = perRunner(z.string().optional());

  it('accepts exactly the current runner-keyed shape', () => {
    expect(schema.safeParse(Object.fromEntries(RUNNER_IDS.map((id) => [id, id]))).success).toBe(true);
    expect(schema.safeParse({ claude: 'x', codex: 'x', opencode: 'x' }).success).toBe(false);
    expect(schema.safeParse({ claude: 'x', codex: 'x', opencode: 'x', pi: 'x', extra: 'x' }).success).toBe(false);
  });
});
