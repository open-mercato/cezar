import { createRunInputBaseSchema } from '@open-mercato/cezar-contract';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { jsonZodValidator } from './validators.ts';

describe('bounded collections reject before element validation (Dependabot52)', () => {
  it('does not visit elements beyond the inline workflow size bound', () => {
    let visits = 0;
    const steps = Array.from({ length: 1_000 }, () => ({
      get id() { visits += 1; return undefined; },
    }));

    const result = createRunInputBaseSchema.safeParse({ task: 'test', steps });

    expect(result.success).toBe(false);
    expect(visits).toBe(0);
    if (result.success) throw new Error('oversized workflow accepted');
    expect(result.error.issues).toEqual([
      expect.objectContaining({ code: 'too_big', path: ['steps'], maximum: 8 }),
    ]);
  });

  it('returns a bounded JSON error at the HTTP middleware boundary', async () => {
    let handled = false;
    const app = new Hono().post('/runs', jsonZodValidator(createRunInputBaseSchema), (c) => {
      handled = true;
      return c.json({ task: c.req.valid('json').task });
    });
    const response = await app.request('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'test', steps: Array.from({ length: 1_000 }, () => ({})) }),
    });

    expect(response.status).toBe(400);
    expect(handled).toBe(false);
    const body: unknown = await response.json();
    expect(body).toEqual({ error: expect.stringContaining('steps:') });
    expect(JSON.stringify(body).length).toBeLessThan(300);
  });

  it('accepts valid workflows at the existing eight-step limit', () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({ id: `step${i}`, prompt: 'test' }));
    const result = createRunInputBaseSchema.safeParse({ task: 'test', steps });
    expect(result.success).toBe(true);
    if (!result.success) throw result.error;
    expect(result.data.steps).toEqual(steps);
  });

  it('still validates malformed elements within the size bound', () => {
    const result = createRunInputBaseSchema.safeParse({ task: 'test', steps: [{}] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('invalid workflow accepted');
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid_type', path: ['steps', 0, 'id'] }),
    );
  });
});
