import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from './agent-runner.js';
import { prependSystemPrompt } from './agent-runner.js';
import { buildClaudeArgs, ClaudeCliRunner } from './claude-cli-runner.js';

/**
 * The per-backend system-prompt delivery mechanism (spec §protocol v2
 * mapping table): claude gets `--append-system-prompt`, codex/opencode get
 * the prompt prepended to the opening user message (`prependSystemPrompt`,
 * shared by both runners).
 */
describe('buildClaudeArgs systemPrompt', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('emits --append-system-prompt with the exact text', () => {
    const args = buildClaudeArgs({ ...spec, systemPrompt: 'Extra rules.\n\n---\n\nContract.' });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('Extra rules.\n\n---\n\nContract.');
  });

  it('omits the flag entirely when no systemPrompt is set', () => {
    expect(buildClaudeArgs(spec)).not.toContain('--append-system-prompt');
  });
});

describe('buildClaudeArgs approval gate', () => {
  const spec = { userPrompt: 'do it', cwd: '/tmp' };

  it('denies unapproved tools without prompting by default', () => {
    const args = buildClaudeArgs(spec, {});
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('dontAsk');
  });

  it('enables Claude approval prompts only when explicitly requested', () => {
    const args = buildClaudeArgs(spec, { CEZ_APPROVAL_GATE: '1' });
    const idx = args.indexOf('--permission-mode');
    expect(args[idx + 1]).toBe('acceptEdits');
  });
});

describe('prependSystemPrompt (codex/opencode delivery)', () => {
  it('prepends the prompt as a leading block of the first user message', () => {
    expect(prependSystemPrompt('Extra rules.', 'do it')).toBe('Extra rules.\n\n---\n\ndo it');
  });

  it('leaves the user prompt untouched when no systemPrompt is set', () => {
    expect(prependSystemPrompt(undefined, 'do it')).toBe('do it');
  });
});

describe('ClaudeCliRunner token usage', () => {
  it('counts the aggregate result usage without re-adding assistant-frame snapshots', async () => {
    const mockBin = fileURLToPath(new URL('../../scripts/mock-claude.mjs', import.meta.url));
    const runner = new ClaudeCliRunner({ bin: mockBin, timeoutMs: 60_000 });
    const events: AgentEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'cez-claude-token-usage-'));

    try {
      const result = await runner.run(
        {
          userPrompt: 'fix the login redirect',
          cwd,
          env: {
            CEZ_HANDOFF_FILE: '',
            CEZ_MOCK_ARGS_FILE: '',
            CEZ_TODOS_FILE: '',
          },
          sessionId: '5f701b42-382a-4a6e-b831-0ab9e56eff58',
        },
        (event) => events.push(event),
      );

      // The mock emits four assistant usage snapshots before its aggregate
      // result usage (1,270 input + 185 output). Only the result is authoritative.
      expect(result.tokensUsed).toBe(1_455);
      expect(events.filter((event) => event.type === 'token-usage')).toEqual([
        { type: 'token-usage', tokensUsed: 1_455 },
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});
