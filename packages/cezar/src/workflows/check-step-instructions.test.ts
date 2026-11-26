import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceConfigPath } from '../paths.ts';
import { RunStore, testCommandFile } from '../runs/store.ts';

const resolveCheckCommand = vi.fn();
vi.mock('./check-instructions.ts', () => ({ resolveCheckCommand }));
const { RunManager } = await import('./run.ts');

/** `runCheckStep`'s two run-level guards around the shared resolver (`check-instructions.ts`). */
describe('check steps under global instructions', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: InstanceType<typeof RunManager>;

  beforeEach(() => {
    resolveCheckCommand.mockReset().mockResolvedValue({ command: 'npm test -- a.test.ts', changed: true, reason: 'related only' });
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-check-instr-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    writeFileSync(workspaceConfigPath(), JSON.stringify({ version: 1, systemPrompt: 'Run only related checks.' }));
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(workspaceConfigPath(), { force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  type Internals = {
    instructedCheckCommand(runId: string, state: { cwd: string }, command: string): Promise<{ command: string; changed: boolean }>;
    clearTestCommandRecord(runId: string): void;
  };
  const internals = () => manager as unknown as Internals;
  const newRun = () => store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [{ id: 'verify', name: 'Verify', kind: 'check' }] });

  it('asks the resolver when instructions are set', async () => {
    const run = newRun();
    expect(await internals().instructedCheckCommand(run.id, { cwd: repoRoot }, 'npm test')).toMatchObject({ command: 'npm test -- a.test.ts', changed: true });
    expect(resolveCheckCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'npm test', repoRoot }));
  });

  it('never lets a fork head steer its own check: its file names are untrusted input', async () => {
    const run = newRun();
    store.updateRun(run.id, { untrustedHead: true });
    expect(await internals().instructedCheckCommand(run.id, { cwd: repoRoot }, 'npm test')).toEqual({ command: 'npm test', changed: false });
    expect(resolveCheckCommand).not.toHaveBeenCalled();
  });

  it('makes no call without instructions', async () => {
    rmSync(workspaceConfigPath(), { force: true });
    expect(await internals().instructedCheckCommand(newRun().id, { cwd: repoRoot }, 'npm test')).toEqual({ command: 'npm test', changed: false });
    expect(resolveCheckCommand).not.toHaveBeenCalled();
  });

  it('empties the related-tests record for each agent round', () => {
    const run = newRun();
    const file = testCommandFile(join(repoRoot, '.ai/cezar'), run.id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'npm test -- old.test.ts\n');
    internals().clearTestCommandRecord(run.id);
    expect(existsSync(file)).toBe(false);
    internals().clearTestCommandRecord(run.id); // absent is fine
  });
});
