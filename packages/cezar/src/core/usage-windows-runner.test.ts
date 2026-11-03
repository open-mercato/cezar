import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import type { UsageWindowsObservation } from '@open-mercato/cezar-contract';
const bin = fileURLToPath(new URL('./__fixtures__/codex/usage-metadata.mjs', import.meta.url));
for (const Runner of [ClaudeCliRunner, CodexAppServerRunner]) {
  for (const mode of ['run', 'startSession'] as const) {
    it(`${Runner.name}.${mode} forwards normalized usage metadata`, async () => {
      const runner = new Runner({ bin, timeoutMs: 5000 });
      const observations: UsageWindowsObservation[] = [];
      const spec = { cwd: process.cwd(), userPrompt: 'ordinary work', onUsageWindows: (o: UsageWindowsObservation) => { observations.push(o); } };
      if (mode === 'run') await runner.run(spec);
      else await runner.startSession(spec, undefined, { autoEndAfterFirstTurn: true }).result;
      expect(observations).toHaveLength(1);
      expect(observations[0]?.provider).toBe(runner.backend);
      expect(observations[0]?.windows[0]?.resetsAt).toBe(2000000000000);
    });
  }
}


for (const mode of ['run', 'startSession'] as const) {
  for (const callback of ['collect', 'throw', 'reject'] as const) {
    it.each(['result', 'errors'] as const)(`ClaudeCliRunner.${mode} preserves terminal %s failure with a ${callback} usage callback`, async field => {
      const root = mkdtempSync(join(tmpdir(), 'claude-terminal-'));
      const resetAt = Math.floor(Date.now() / 1000) * 1000 + 3_600_000;
      const resultText = `Claude AI usage limit reached|${resetAt / 1000}`;
      const terminalBin = join(root, 'terminal.mjs');
      writeFileSync(terminalBin, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify({ type: 'result', is_error: true, ...(field === 'result' ? { result: resultText } : { subtype: 'error_during_execution', errors: [resultText] }) }))});\nprocess.exit(1);\n`, { mode: 0o755 });
      const observations: UsageWindowsObservation[] = [];
      try {
        const runner = new ClaudeCliRunner({ bin: terminalBin, timeoutMs: 5000 });
        const spec = { cwd: root, userPrompt: 'ordinary work', onUsageWindows: (o: UsageWindowsObservation) => {
          observations.push(o);
          if (callback === 'throw') throw new Error('metadata callback failed');
          if (callback === 'reject') return Promise.reject(new Error('persistence failed'));
        } };
        const errors: string[] = [];
        const onEvent = (event: import('./agent-runner.ts').AgentEvent) => { if (event.type === 'error') errors.push(event.message); };
        const result = mode === 'run' ? runner.run(spec, onEvent)
          : runner.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
        await expect(result).rejects.toThrow('claude CLI exited with code 1');
        expect(observations).toHaveLength(1);
        expect(observations[0]!.windows).toEqual([expect.objectContaining({ id: 'terminal-limit', resetsAt: resetAt, status: 'blocked' })]);
        if (field === 'result') expect(errors).toContain(resultText);
        expect(errors).not.toContain('metadata callback failed');
        expect(errors).not.toContain('persistence failed');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}
