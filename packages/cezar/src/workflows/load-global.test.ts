import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOWS_DIR, loadWorkflows } from './load.ts';

const wf = (name: string, prompt: string) => `name: ${name}\nsteps:\n  - id: a\n    name: A\n    prompt: ${prompt}\n`;

describe('global workflows (#1984)', () => {
  let root: string;
  let home: string;
  let globalDir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wf-root-'));
    home = await mkdtemp(join(tmpdir(), 'wf-home-'));
    globalDir = join(home, 'workflows');
    await mkdir(join(root, WORKFLOWS_DIR), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('discovers global workflows and tags them scope: global', async () => {
    await mkdir(globalDir);
    await writeFile(join(globalDir, 'shared.yaml'), wf('shared', 'hi'));
    const { workflows } = await loadWorkflows(root, globalDir);
    const w = workflows.find((x) => x.name === 'shared');
    expect(w?.scope).toBe('global');
    expect(w?.source).toBe('file');
  });

  it('project wins over global, global wins over built-in', async () => {
    await mkdir(globalDir);
    await writeFile(join(globalDir, 'dup.yaml'), wf('dup', 'global'));
    await writeFile(join(root, WORKFLOWS_DIR, 'dup.yaml'), wf('dup', 'project'));
    await writeFile(join(globalDir, 'quick.yaml'), wf('quick-task', 'global'));
    const { workflows } = await loadWorkflows(root, globalDir);
    const dup = workflows.filter((x) => x.name === 'dup');
    expect(dup).toHaveLength(1);
    expect(dup[0]?.scope).toBeUndefined();
    const quick = workflows.find((x) => x.name === 'quick-task');
    expect(quick?.scope).toBe('global');
  });

  it('a missing global dir is a no-op and a bad global file is reported', async () => {
    const none = await loadWorkflows(root, join(home, 'absent'));
    expect(none.issues).toEqual([]);
    await mkdir(globalDir);
    await writeFile(join(globalDir, 'bad.yaml'), 'name: x\n');
    const bad = await loadWorkflows(root, globalDir);
    expect(bad.issues).toHaveLength(1);
    expect(bad.workflows.some((x) => x.name === 'quick-task')).toBe(true);
  });
});
