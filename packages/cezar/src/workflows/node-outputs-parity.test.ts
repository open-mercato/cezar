import { describe, expect, it } from 'vitest';
import { NODE_CATALOG } from './graph.ts';

// Test-only reach into the cockpit's source, ugly on purpose: the two lists must not drift.
// Dynamic URL import keeps `packages/cezar`'s `rootDir` typecheck happy.
const { NODE_OUTPUTS } = await import(
  new URL('../../../web/src/lib/workflow-node-outputs.ts', import.meta.url).href
) as { NODE_OUTPUTS: Record<string, string[]> };

describe("the cockpit's node outputs", () => {
  it('covers the exact same node types as NODE_CATALOG', () => {
    expect(Object.keys(NODE_OUTPUTS).sort()).toEqual(NODE_CATALOG.map((entry) => entry.type).sort());
  });

  it.each(NODE_CATALOG.map((entry) => [entry.type, entry.outputs] as const))('%s matches NODE_CATALOG', (type, outputs) => {
    expect(NODE_OUTPUTS[type]).toEqual(outputs);
  });
});
