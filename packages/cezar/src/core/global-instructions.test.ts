import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FORMAT_BOUND_GLOBAL_HEADING, GLOBAL_INSTRUCTIONS_HEADING, instructSpec, readGlobalInstructions, withGlobalInstructions } from './global-instructions.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { createRunner } from './runner-factory.ts';
import { workspaceConfigPath } from '../paths.ts';

const RULE = 'Run only checks relevant to the change.';

describe('global instructions for every model call', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const configWith = (value: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-global-'));
    dirs.push(dir);
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ version: 1, systemPrompt: value }));
    return path;
  };

  it('reads Settings → Global instructions, and nothing from a missing, blank, oversized or broken file', () => {
    expect(readGlobalInstructions(configWith(`  ${RULE}  `))).toBe(RULE);
    expect(readGlobalInstructions(configWith('   '))).toBeUndefined();
    expect(readGlobalInstructions(configWith('x'.repeat(20_001)))).toBeUndefined();
    expect(readGlobalInstructions(configWith(42))).toBeUndefined();
    expect(readGlobalInstructions(join(tmpdir(), 'cez-no-such-dir', 'config.json'))).toBeUndefined();
    const broken = configWith(RULE);
    writeFileSync(broken, '{');
    expect(readGlobalInstructions(broken)).toBeUndefined();
  });

  it('puts them first, once, and tells the agent to pass them to its subagents', () => {
    expect(withGlobalInstructions(undefined, RULE)).toBe(`${GLOBAL_INSTRUCTIONS_HEADING}\n\n${RULE}`);
    expect(withGlobalInstructions('Write JSON.', RULE)).toBe(`${GLOBAL_INSTRUCTIONS_HEADING}\n\n${RULE}\n\n---\n\nWrite JSON.`);
    // A workflow step composes (and records) them itself: no second copy.
    const composed = `## Global instructions\n\n${RULE}\n\n---\n\nStep prompt`;
    expect(withGlobalInstructions(composed, RULE)).toBe(composed);
    expect(withGlobalInstructions('Write JSON.', undefined)).toBe('Write JSON.');
    expect(GLOBAL_INSTRUCTIONS_HEADING).toMatch(/subagent/);
  });

  it('adds a block for a short rule quoted elsewhere, and never a second one beside a composed block', () => {
    expect(withGlobalInstructions('Answer as JSON. Be concise.', 'Be concise.')).toContain(`${GLOBAL_INSTRUCTIONS_HEADING}\n\nBe concise.`);
    // Settings saved between the step composer's read and this one: the older block stays alone.
    const composedOld = `Skill body\n\n---\n\n## Global instructions\n\nThese user instructions apply…\n\nOld rule.`;
    expect(withGlobalInstructions(composedOld, 'New rule.')).toBe(composedOld);
    const manager = `You are a manager.\n\nGlobal instructions from the user's cezar settings. They apply…\nRule.`;
    expect(withGlobalInstructions(manager, 'Rule.')).toBe(manager);
  });

  it('keeps a parsed helper\'s answer format: format-bound specs get the softer heading', () => {
    const spec = instructSpec({ systemPrompt: 'Respond with ONLY JSON.', userPrompt: 'x', cwd: '/', globalInstructions: 'format-bound' }, () => 'Answer in bullet points.');
    expect(spec.systemPrompt).toBe(`${FORMAT_BOUND_GLOBAL_HEADING}\n\nAnswer in bullet points.\n\n---\n\nRespond with ONLY JSON.`);
  });

  it('skips a spec that opted out — a probe, a tool call the user approved verbatim', () => {
    const spec = { userPrompt: 'Reply with OK.', cwd: '/', globalInstructions: false as const };
    expect(instructSpec(spec, () => RULE)).toBe(spec);
    expect(instructSpec({ userPrompt: 'x', cwd: '/' }, () => RULE).systemPrompt).toContain(RULE);
  });

  // The shared place: every runner `createRunner` builds, `run` and `startSession` alike.
  it.each([
    ['claude', ClaudeCliRunner],
    ['codex', CodexAppServerRunner],
  ] as const)('createRunner(%s) hands the runner a spec carrying them', async (backend, Runner) => {
    writeFileSync(workspaceConfigPath(), JSON.stringify({ version: 1, systemPrompt: RULE }));
    const run = vi.spyOn(Runner.prototype, 'run').mockResolvedValue({ text: '' } as never);
    const start = vi.spyOn(Runner.prototype, 'startSession').mockReturnValue({} as never);
    const runner = createRunner(backend);
    await runner.run({ systemPrompt: 'Name it.', userPrompt: 'x', cwd: tmpdir() }, () => undefined);
    runner.startSession({ userPrompt: 'x', cwd: tmpdir() }, () => undefined);
    expect(run.mock.calls[0]![0].systemPrompt).toBe(`${GLOBAL_INSTRUCTIONS_HEADING}\n\n${RULE}\n\n---\n\nName it.`);
    expect(start.mock.calls[0]![0].systemPrompt).toBe(`${GLOBAL_INSTRUCTIONS_HEADING}\n\n${RULE}`);
    rmSync(workspaceConfigPath(), { force: true });
  });
});
