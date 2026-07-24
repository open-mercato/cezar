import { describe, expect, it } from 'vitest'

import { toolDisplay, type ToolDisplay } from './tool-display'

/**
 * The web half of the display-model guard. The heavy lifting lives on the server side —
 * `src/server/tool-display-mirror.test.ts` runs BOTH implementations over one table and pins
 * them to the same literals — but that suite runs under the server's NodeNext resolver. This
 * one exists to prove the mirror also loads and behaves under the WEB project's resolver (the
 * `.js` → `.ts` specifier mapping Vite applies is exactly what would break silently otherwise),
 * with a spot check per behavior family. The literals are the shared ones.
 */
describe('protocol/tool-display — the mirror works under the bundle resolver', () => {
  it.each<{ name: string; input?: unknown; expected: ToolDisplay }>([
    {
      name: 'Bash',
      input: { command: 'npm test', description: 'Run the unit tests' },
      expected: { toolKind: 'execute', title: 'Ran npm test', subtitle: 'Run the unit tests' },
    },
    {
      name: 'fileChange',
      input: { changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' }] },
      expected: { toolKind: 'edit', title: 'Edit 3 files' },
    },
    {
      name: 'Grep',
      input: { pattern: 'AgentEvent', path: 'src/core' },
      expected: { toolKind: 'search', title: 'Search AgentEvent', subtitle: 'src/core' },
    },
    {
      name: 'imageView',
      input: { path: '/tmp/checkout-preview.png' },
      expected: { toolKind: 'read', title: 'View image /tmp/checkout-preview.png' },
    },
    {
      name: 'Task',
      input: { description: 'Explore the repo', subagent_type: 'Explore' },
      expected: { toolKind: 'task', title: 'Task: Explore the repo', subtitle: 'Explore' },
    },
    {
      name: 'Agent',
      input: { description: 'Review the diff', subagent_type: 'code-reviewer' },
      expected: { toolKind: 'task', title: 'Agent: Review the diff', subtitle: 'code-reviewer' },
    },
    {
      name: 'Skill',
      input: { skill: 'om-auto-fix-issue', args: '529' },
      expected: { toolKind: 'task', title: 'Skill: om-auto-fix-issue', subtitle: '529' },
    },
    { name: 'TodoWrite', input: { todos: [] }, expected: { toolKind: 'plan', title: 'Update plan' } },
    { name: 'TaskCreate', input: { subject: 'x' }, expected: { toolKind: 'plan', title: 'Update plan' } },
    { name: 'TaskUpdate', input: { taskId: '1' }, expected: { toolKind: 'plan', title: 'Update plan' } },
    { name: 'TaskList', expected: { toolKind: 'plan', title: 'Update plan' } },
    { name: 'contextCompaction', expected: { toolKind: 'other', title: 'Compacted context' } },
    {
      name: 'mcp__github__list_prs',
      input: { state: 'open' },
      expected: { toolKind: 'other', title: 'github.list_prs' },
    },
    {
      name: 'SomeCustomTool',
      input: { description: 'do a thing' },
      expected: { toolKind: 'other', title: 'SomeCustomTool', subtitle: 'do a thing' },
    },
  ])('$name → $expected.title', ({ name, input, expected }) => {
    expect(toolDisplay(name, input)).toEqual(expected)
  })

  it('never throws on wire junk', () => {
    for (const input of [undefined, null, 42, [], { command: { nested: true } }, Object.create(null)]) {
      expect(typeof toolDisplay('Bash', input).title).toBe('string')
      expect(typeof toolDisplay(undefined as unknown as string, input).title).toBe('string')
    }
  })
})
