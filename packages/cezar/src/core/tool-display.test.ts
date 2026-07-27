import { describe, expect, it } from 'vitest';

import { toolDisplay, type ToolDisplay } from './tool-display.js';

describe('toolDisplay', () => {
  describe('known tools across backends', () => {
    it.each<{ name: string; input?: unknown; expected: ToolDisplay }>([
      // ---- execute: claude Bash / opencode bash / codex commandExecution ----
      {
        name: 'Bash',
        input: { command: 'npm test', description: 'Run the unit tests' },
        expected: { toolKind: 'execute', title: 'Ran npm test', subtitle: 'Run the unit tests' },
      },
      {
        name: 'bash',
        input: { command: 'git status' },
        expected: { toolKind: 'execute', title: 'Ran git status', subtitle: undefined },
      },
      {
        name: 'commandExecution',
        input: { command: ['npm', 'run', 'build'] },
        expected: { toolKind: 'execute', title: 'Ran npm run build', subtitle: undefined },
      },
      {
        name: 'Bash',
        input: {},
        expected: { toolKind: 'execute', title: 'Ran', subtitle: undefined },
      },

      // ---- edit family: claude Edit/Write/NotebookEdit, opencode edit/write, codex fileChange ----
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
      {
        name: 'MultiEdit',
        input: { file_path: 'src/core/ndjson.ts', edits: [] },
        expected: { toolKind: 'edit', title: 'Edit src/core/ndjson.ts' },
      },
      {
        name: 'Write',
        input: { file_path: 'README.md', content: '# hi' },
        expected: { toolKind: 'edit', title: 'Write README.md' },
      },
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
      {
        name: 'fileChange',
        input: { changes: [] },
        expected: { toolKind: 'edit', title: 'Edit' },
      },

      // ---- read / search: claude Read/Glob/Grep, opencode read/glob/grep ----
      {
        name: 'Read',
        input: { file_path: 'package.json' },
        expected: { toolKind: 'read', title: 'Read package.json' },
      },
      {
        name: 'read',
        input: { filePath: 'src/index.ts' },
        expected: { toolKind: 'read', title: 'Read src/index.ts' },
      },
      {
        name: 'imageView',
        input: { path: '/tmp/checkout-preview.png' },
        expected: { toolKind: 'read', title: 'View image /tmp/checkout-preview.png' },
      },
      {
        name: 'Glob',
        input: { pattern: 'src/**/*.ts' },
        expected: { toolKind: 'search', title: 'Search src/**/*.ts', subtitle: undefined },
      },
      {
        name: 'Grep',
        input: { pattern: 'AgentEvent', path: 'src/core' },
        expected: { toolKind: 'search', title: 'Search AgentEvent', subtitle: 'src/core' },
      },
      {
        name: 'grep',
        input: { pattern: 'todo' },
        expected: { toolKind: 'search', title: 'Search todo', subtitle: undefined },
      },

      // ---- fetch: claude WebFetch/WebSearch, opencode webfetch, codex webSearch ----
      {
        name: 'WebFetch',
        input: { url: 'https://example.com/docs', prompt: 'summarize' },
        expected: { toolKind: 'fetch', title: 'Fetch https://example.com/docs' },
      },
      {
        name: 'webfetch',
        input: { url: 'https://example.com' },
        expected: { toolKind: 'fetch', title: 'Fetch https://example.com' },
      },
      {
        name: 'WebSearch',
        input: { query: 'vitest projects config' },
        expected: { toolKind: 'fetch', title: 'Web search vitest projects config' },
      },
      {
        name: 'webSearch',
        input: { query: 'hono sse' },
        expected: { toolKind: 'fetch', title: 'Web search hono sse' },
      },

      // ---- task (subagent spawn): claude Task, opencode task ----
      {
        name: 'Task',
        input: { description: 'Explore the repo', prompt: 'long prompt…', subagent_type: 'Explore' },
        expected: { toolKind: 'task', title: 'Task: Explore the repo', subtitle: 'Explore' },
      },
      {
        name: 'task',
        input: {},
        expected: { toolKind: 'task', title: 'Task', subtitle: undefined },
      },

      // ---- agent (claude's current subagent spelling — #529) ----
      {
        name: 'Agent',
        input: { description: 'Review the diff', prompt: 'long prompt…', subagent_type: 'code-reviewer' },
        expected: { toolKind: 'task', title: 'Agent: Review the diff', subtitle: 'code-reviewer' },
      },
      // No description: the subagent type carries the row rather than repeating
      // itself in the subtitle.
      {
        name: 'Agent',
        input: { subagent_type: 'Explore' },
        expected: { toolKind: 'task', title: 'Agent: Explore', subtitle: undefined },
      },
      {
        name: 'agent',
        input: {},
        expected: { toolKind: 'task', title: 'Agent', subtitle: undefined },
      },

      // ---- skill (claude's Skill invocation — #529) ----
      {
        name: 'Skill',
        input: { skill: 'om-auto-fix-issue', args: '529' },
        expected: { toolKind: 'task', title: 'Skill: om-auto-fix-issue', subtitle: '529' },
      },
      {
        name: 'skill',
        input: { skill: 'om-code-review' },
        expected: { toolKind: 'task', title: 'Skill: om-code-review', subtitle: undefined },
      },
      {
        name: 'Skill',
        input: {},
        expected: { toolKind: 'task', title: 'Skill', subtitle: undefined },
      },

      // ---- plan: claude TodoWrite, opencode todowrite, codex todoList/plan ----
      {
        name: 'TodoWrite',
        input: { todos: [{ content: 'x', status: 'pending' }] },
        expected: { toolKind: 'plan', title: 'Update plan' },
      },
      { name: 'todowrite', expected: { toolKind: 'plan', title: 'Update plan' } },
      { name: 'todoList', expected: { toolKind: 'plan', title: 'Update plan' } },
      { name: 'plan', expected: { toolKind: 'plan', title: 'Update plan' } },
      { name: 'contextCompaction', expected: { toolKind: 'other', title: 'Compacted context' } },
      { name: 'TaskCreate', input: { subject: 'x' }, expected: { toolKind: 'plan', title: 'Update plan' } },
      { name: 'TaskUpdate', input: { taskId: '1' }, expected: { toolKind: 'plan', title: 'Update plan' } },
      { name: 'TaskList', expected: { toolKind: 'plan', title: 'Update plan' } },

      // ---- MCP: codex mcpToolCall item + claude/opencode mcp__server__tool names ----
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
      {
        name: 'mcp__srv__tool__extra',
        expected: { toolKind: 'other', title: 'srv.tool__extra' },
      },
    ])('$name → $expected.title', ({ name, input, expected }) => {
      expect(toolDisplay(name, input)).toEqual(expected);
    });
  });

  describe('unknown tools use the heuristic label as subtitle', () => {
    it.each<{ label: string; input: unknown; subtitle: string | undefined }>([
      { label: 'description wins first', input: { description: 'do a thing', query: 'q' }, subtitle: 'do a thing' },
      { label: 'query before url', input: { query: 'search terms', url: 'https://x' }, subtitle: 'search terms' },
      { label: 'url before paths', input: { url: 'https://x', path: 'a.ts' }, subtitle: 'https://x' },
      { label: 'filePath before path', input: { filePath: 'a.ts', path: 'b.ts' }, subtitle: 'a.ts' },
      { label: 'file_path accepted', input: { file_path: 'c.ts' }, subtitle: 'c.ts' },
      { label: 'path before pattern', input: { path: 'dir/', pattern: '*.ts' }, subtitle: 'dir/' },
      { label: 'pattern before name', input: { pattern: '*.md', name: 'n' }, subtitle: '*.md' },
      { label: 'name as last resort', input: { name: 'the-name' }, subtitle: 'the-name' },
      { label: 'empty strings are skipped', input: { description: '  ', query: 'real' }, subtitle: 'real' },
      { label: 'non-string candidates are skipped', input: { description: 42, query: 'q' }, subtitle: 'q' },
      { label: 'nothing usable → no subtitle', input: { foo: 'bar' }, subtitle: undefined },
    ])('$label', ({ input, subtitle }) => {
      expect(toolDisplay('SomeCustomTool', input)).toEqual({
        toolKind: 'other',
        title: 'SomeCustomTool',
        subtitle,
      });
    });

    it('keeps the backend-given name as the title', () => {
      expect(toolDisplay('exotic_mcp_thing').title).toBe('exotic_mcp_thing');
      expect(toolDisplay('exotic_mcp_thing').toolKind).toBe('other');
    });
  });

  describe('hostile inputs never throw', () => {
    const junkInputs: unknown[] = [
      undefined,
      null,
      42,
      'a string',
      true,
      [],
      [{ nested: [null] }],
      { command: null },
      { command: 123 },
      { command: [null, 42, { deep: true }] },
      { command: { deeply: { nested: 'junk' } } },
      { changes: 'not-an-array' },
      { changes: [null, 42, 'str', { path: 7 }] },
      { file_path: { not: 'a string' } },
      { description: ['array'], query: {}, url: 0, path: false },
      Object.create(null),
    ];

    const names = ['Bash', 'commandExecution', 'Edit', 'fileChange', 'Read', 'Grep', 'WebFetch', 'Task', 'mcpToolCall', 'TotallyUnknown'];

    it.each(names.map((name) => ({ name })))('$name survives every junk input', ({ name }) => {
      for (const input of junkInputs) {
        const display = toolDisplay(name, input);
        expect(typeof display.title).toBe('string');
        expect(display.title.length).toBeGreaterThan(0);
        expect(typeof display.toolKind).toBe('string');
      }
    });

    it('a non-string name (wire junk) still yields a display', () => {
      // The signature says string, but wire data can lie — cast on purpose.
      const display = toolDisplay(undefined as unknown as string, { query: 'q' });
      expect(display).toEqual({ toolKind: 'other', title: 'Tool', subtitle: 'q' });
    });

    it('an empty name falls back to a generic title', () => {
      expect(toolDisplay('', {}).title).toBe('Tool');
    });
  });

  describe('display normalization', () => {
    it('collapses multi-line commands to one line', () => {
      expect(toolDisplay('Bash', { command: 'npm run build &&\n  npm test' }).title).toBe(
        'Ran npm run build && npm test',
      );
    });

    it('caps very long labels with an ellipsis', () => {
      const { title } = toolDisplay('Bash', { command: `echo ${'x'.repeat(500)}` });
      expect(title.length).toBeLessThanOrEqual('Ran '.length + 120);
      expect(title.endsWith('…')).toBe(true);
    });
  });
});
