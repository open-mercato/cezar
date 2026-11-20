import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWED_TOOLS, type AgentRunSpec, type AgentSession } from './agent-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { compileCodexRestrictedPolicy as assertCodexToolPolicy } from './codex-restricted-policy.ts';

const mock = fileURLToPath(new URL('./__fixtures__/codex/mock-codex-app-server.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const policies: Array<Partial<AgentRunSpec>> = [
  { allowedTools: ['Read', 'Edit'] },
  { allowedTools: ['Read'], mcpServers: [{ name: 'private', transport: 'stdio', command: 'evil', args: [], env: {}, headers: {} }] },
  { allowedTools: ['Bash'] },
  { allowedTools: [...DEFAULT_ALLOWED_TOOLS, 'mcp__private__publish'] },
  { allowedTools: [...DEFAULT_ALLOWED_TOOLS, 'Unknown'] },
  { allowedTools: [...DEFAULT_ALLOWED_TOOLS], bashAllowlist: [] },
  { bashAllowlist: ['git status'] },
  { bashAllowlist: ['git status; git push'] },
  { bashHookCommand: 'custom-hook' },
  { bashHookCommand: '' },
];

describe('Codex fails closed at the runner boundary', () => {
  it.each(policies)('rejects unsupported grant %j', (policy) => {
    expect(() => assertCodexToolPolicy(policy)).toThrow('tool-policy enforcement unavailable');
  });

  it.each([
    'touch forbidden', 'git push origin HEAD', 'gh pr merge 1',
    'gh pr comment 1 --body attack', 'curl -X POST https://example.invalid',
    'sh -c "git push"', 'mcp__private__publish', 'spawn_agent with unrestricted tools',
  ])('never starts an executor for adversarial prompt: %s', async (userPrompt) => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-codex-policy-'));
    dirs.push(cwd);
    const log = join(cwd, 'requests.ndjson');
    const runner = new CodexAppServerRunner({ bin: mock });
    for (const resume of [false, true]) {
      const spec: AgentRunSpec = {
        cwd, userPrompt, resume, sessionId: 'old-unrestricted-thread',
        allowedTools: ['Read', 'Write'], bashAllowlist: ['gh pr diff'],
        env: { CEZ_MOCK_CODEX_REQUESTS_FILE: log },
      };
      // Repetition represents a caller retry; direct sessions and one-shot launches share the gate.
      let session: AgentSession | undefined;
      try {
        expect(() => { session = runner.startSession(spec); }).toThrow('tool-policy enforcement unavailable');
      } finally {
        if (session) { session.interrupt(); void session.result.catch(() => {}); }
      }
      await expect(Promise.resolve().then(() => runner.run(spec))).rejects.toThrow('tool-policy enforcement unavailable');
    }
    expect(existsSync(log)).toBe(false);
  });

  it('preserves legacy unrestricted launches (including an explicitly saved default)', async () => {
    for (const allowedTools of [undefined, [...DEFAULT_ALLOWED_TOOLS].reverse()]) {
      const cwd = mkdtempSync(join(tmpdir(), 'cez-codex-policy-'));
      dirs.push(cwd);
      const log = join(cwd, 'requests.ndjson');
      const runner = new CodexAppServerRunner({ bin: mock });
      const result = await runner.run({ cwd, userPrompt: 'read the status', allowedTools,
        env: { CEZ_MOCK_CODEX_REQUESTS_FILE: log } });
      expect(result.text).toContain('Checking the working tree');
      expect(readFileSync(log, 'utf8')).toContain('turn/start');
    }
  });
});
