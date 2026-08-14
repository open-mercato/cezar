import { describe, expect, it } from 'vitest';

import { toolDisplay as webToolDisplay } from '@open-mercato/cezar-api-client';
import { toolDisplay, type ToolDisplay } from '../core/tool-display.ts';

/**
 * The behavior half of the protocol-v2 mirror guard (`api-types.test.ts` is the shape half).
 *
 * `web/api-client/src/protocol/tool-display.ts` is a hand-mirrored copy of `src/core/tool-display.ts`
 * — the bundle cannot import the server's module graph (NodeNext vs bundler, see
 * `packages/api-client/src/dto/types.ts`), but the two implementations must keep SAYING the same thing, or
 * the thread would title a tool call differently from the server-side consumers. So this suite
 * runs BOTH over one representative table (a case per branch of the display model: every tool
 * family, the MCP naming schemes, the unknown-tool heuristic, normalization, and hostile wire
 * junk) and asserts, per input, that each matches the expected literal — the same literals the
 * server's own `tool-display.test.ts` pins — and therefore each other.
 *
 * Lives on the server side because that is the program that can import both modules (the web
 * mirror is written with `.js` relative specifiers for exactly this reason).
 */

/** One case per behavior branch — drawn from `src/core/tool-display.test.ts`'s tables. */
const TABLE: Array<{ name: string; input?: unknown; expected: ToolDisplay }> = [
  // execute (string command + description, argv command, nothing usable)
  {
    name: 'Bash',
    input: { command: 'npm test', description: 'Run the unit tests' },
    expected: { toolKind: 'execute', title: 'Ran npm test', subtitle: 'Run the unit tests' },
  },
  {
    name: 'commandExecution',
    input: { command: ['npm', 'run', 'build'] },
    expected: { toolKind: 'execute', title: 'Ran npm run build', subtitle: undefined },
  },
  { name: 'Bash', input: {}, expected: { toolKind: 'execute', title: 'Ran', subtitle: undefined } },

  // edit family (snake_case, camelCase, single/multi/empty fileChange, write, notebook)
  {
    name: 'Edit',
    input: { file_path: 'src/core/usage.ts', old_string: 'a', new_string: 'b' },
    expected: { toolKind: 'edit', title: 'Edit src/core/usage.ts' },
  },
  {
    name: 'edit',
    input: { filePath: 'web/app/src/App.tsx' },
    expected: { toolKind: 'edit', title: 'Edit web/app/src/App.tsx' },
  },
  { name: 'Write', input: { file_path: 'README.md' }, expected: { toolKind: 'edit', title: 'Write README.md' } },
  {
    name: 'NotebookEdit',
    input: { notebook_path: 'analysis.ipynb' },
    expected: { toolKind: 'edit', title: 'Edit analysis.ipynb' },
  },
  {
    name: 'fileChange',
    input: { changes: [{ path: 'src/a.ts', kind: 'update' }] },
    expected: { toolKind: 'edit', title: 'Edit src/a.ts' },
  },
  {
    name: 'fileChange',
    input: { changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' }] },
    expected: { toolKind: 'edit', title: 'Edit 3 files' },
  },
  { name: 'fileChange', input: { changes: [] }, expected: { toolKind: 'edit', title: 'Edit' } },

  // read / search
  { name: 'Read', input: { file_path: 'package.json' }, expected: { toolKind: 'read', title: 'Read package.json' } },
  {
    name: 'imageView',
    input: { path: '/tmp/checkout-preview.png' },
    expected: { toolKind: 'read', title: 'View image /tmp/checkout-preview.png' },
  },
  {
    name: 'Grep',
    input: { pattern: 'AgentEvent', path: 'src/core' },
    expected: { toolKind: 'search', title: 'Search AgentEvent', subtitle: 'src/core' },
  },
  {
    name: 'Glob',
    input: { pattern: 'src/**/*.ts' },
    expected: { toolKind: 'search', title: 'Search src/**/*.ts', subtitle: undefined },
  },

  // fetch
  {
    name: 'WebFetch',
    input: { url: 'https://example.com/docs', prompt: 'summarize' },
    expected: { toolKind: 'fetch', title: 'Fetch https://example.com/docs' },
  },
  {
    name: 'webSearch',
    input: { query: 'hono sse' },
    expected: { toolKind: 'fetch', title: 'Web search hono sse' },
  },

  // task
  {
    name: 'Task',
    input: { description: 'Explore the repo', prompt: 'long prompt…', subagent_type: 'Explore' },
    expected: { toolKind: 'task', title: 'Task: Explore the repo', subtitle: 'Explore' },
  },
  { name: 'task', input: {}, expected: { toolKind: 'task', title: 'Task', subtitle: undefined } },

  // agent / skill (claude's current subagent + skill spellings)
  {
    name: 'Agent',
    input: { description: 'Review the diff', subagent_type: 'code-reviewer' },
    expected: { toolKind: 'task', title: 'Agent: Review the diff', subtitle: 'code-reviewer' },
  },
  {
    name: 'Agent',
    input: { subagent_type: 'Explore' },
    expected: { toolKind: 'task', title: 'Agent: Explore', subtitle: undefined },
  },
  {
    name: 'Skill',
    input: { skill: 'om-auto-fix-issue', args: '529' },
    expected: { toolKind: 'task', title: 'Skill: om-auto-fix-issue', subtitle: '529' },
  },
  { name: 'Skill', input: {}, expected: { toolKind: 'task', title: 'Skill', subtitle: undefined } },

  // plan
  { name: 'TodoWrite', input: { todos: [] }, expected: { toolKind: 'plan', title: 'Update plan' } },
  { name: 'todoList', expected: { toolKind: 'plan', title: 'Update plan' } },
  { name: 'contextCompaction', expected: { toolKind: 'other', title: 'Compacted context' } },

  // MCP, both naming schemes
  {
    name: 'mcpToolCall',
    input: { server: 'linear', tool: 'create_issue' },
    expected: { toolKind: 'other', title: 'linear.create_issue' },
  },
  {
    name: 'mcpToolCall',
    input: { arguments: {} },
    expected: { toolKind: 'other', title: 'MCP tool', subtitle: undefined },
  },
  {
    name: 'mcp__github__list_prs',
    input: { state: 'open' },
    expected: { toolKind: 'other', title: 'github.list_prs' },
  },
  { name: 'mcp__srv__tool__extra', expected: { toolKind: 'other', title: 'srv.tool__extra' } },

  // unknown-tool heuristic (priority order) and generic fallbacks
  {
    name: 'SomeCustomTool',
    input: { description: 'do a thing', query: 'q' },
    expected: { toolKind: 'other', title: 'SomeCustomTool', subtitle: 'do a thing' },
  },
  {
    name: 'SomeCustomTool',
    input: { foo: 'bar' },
    expected: { toolKind: 'other', title: 'SomeCustomTool', subtitle: undefined },
  },
  { name: '', input: {}, expected: { toolKind: 'other', title: 'Tool', subtitle: undefined } },

  // normalization: whitespace collapse + the 120-char cap
  {
    name: 'Bash',
    input: { command: 'npm run build &&\n  npm test' },
    expected: { toolKind: 'execute', title: 'Ran npm run build && npm test', subtitle: undefined },
  },
  {
    name: 'Bash',
    input: { command: `echo ${'x'.repeat(500)}` },
    expected: { toolKind: 'execute', title: `Ran ${`echo ${'x'.repeat(500)}`.slice(0, 119)}…`, subtitle: undefined },
  },
];

describe('web protocol mirror — toolDisplay says exactly what the server says', () => {
  it.each(TABLE)('$name → $expected.title', ({ name, input, expected }) => {
    expect(toolDisplay(name, input)).toEqual(expected);
    expect(webToolDisplay(name, input)).toEqual(expected);
  });

  it('agrees on hostile wire junk too — neither side may throw or diverge', () => {
    const junkInputs: unknown[] = [
      undefined,
      null,
      42,
      'a string',
      [],
      { command: null },
      { command: [null, 42, { deep: true }] },
      { changes: 'not-an-array' },
      { changes: [null, 42, 'str', { path: 7 }] },
      { file_path: { not: 'a string' } },
      Object.create(null),
    ];
    const names = ['Bash', 'fileChange', 'Read', 'Grep', 'Task', 'Agent', 'Skill', 'mcpToolCall', 'TotallyUnknown'];
    for (const name of names) {
      for (const input of junkInputs) {
        expect(webToolDisplay(name, input)).toEqual(toolDisplay(name, input));
      }
    }
  });
});
