import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { parseStructured, proposeWorkflowName } from '../../src/planner.js';

test('proposeWorkflowName slugs a title to the file-name form', () => {
  assert.equal(proposeWorkflowName('Fix And Review'), 'fix-and-review');
  assert.equal(proposeWorkflowName('  Ship it!  '), 'ship-it');
  assert.equal(proposeWorkflowName('already-kebab'), 'already-kebab');
});

test('proposeWorkflowName degrades a blank / slug-less title to undefined', () => {
  // The caller keeps the current name rather than blanking it when nothing survives.
  assert.equal(proposeWorkflowName(undefined), undefined);
  assert.equal(proposeWorkflowName('   '), undefined);
  assert.equal(proposeWorkflowName('!!! ???'), undefined);
});

test('parseStructured reads the optional planner title alongside the steps', () => {
  const schema = z.object({
    title: z.string().optional(),
    steps: z.array(z.object({ name: z.string() })),
  });
  const parsed = parseStructured(
    '```json\n{"title":"fix-and-review","steps":[{"name":"Implement"}]}\n```',
    schema,
  );
  assert.deepEqual(parsed, { title: 'fix-and-review', steps: [{ name: 'Implement' }] });
});
