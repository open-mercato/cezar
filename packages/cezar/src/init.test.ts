import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCommand } from './init.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

describe('init example creation', () => {
  let root: string;
  let workflow: string;
  let skill: string;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'cez-init-'));
    workflow = join(root, '.ai/cezar/workflows/fix-and-verify.yaml');
    skill = join(root, '.ai/cezar/skills/project-conventions.md');
    vi.mocked(fs.writeFileSync).mockImplementation(actualFs.writeFileSync);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('creates both examples and leaves existing content untouched on subsequent init', () => {
    initCommand(root);
    expect(fs.readFileSync(workflow, 'utf8')).toContain('name: fix-and-verify');
    expect(fs.readFileSync(skill, 'utf8')).toContain('name: project-conventions');
    actualFs.writeFileSync(workflow, 'user workflow');
    actualFs.writeFileSync(skill, 'user skill');
    initCommand(root);
    expect(fs.readFileSync(workflow, 'utf8')).toBe('user workflow');
    expect(fs.readFileSync(skill, 'utf8')).toBe('user skill');
    expect(console.log).toHaveBeenCalledWith(`  = ${workflow} (exists, left untouched)`);
  });

  it('preserves a file created concurrently immediately before the write', () => {
    vi.mocked(fs.writeFileSync).mockImplementation((...args) => {
      if (args[0] === workflow) actualFs.writeFileSync(workflow, 'concurrent user content');
      return actualFs.writeFileSync(...args);
    });
    initCommand(root);
    expect(fs.readFileSync(workflow, 'utf8')).toBe('concurrent user content');
    expect(fs.existsSync(skill)).toBe(true);
    expect(console.log).toHaveBeenCalledWith(`  = ${workflow} (exists, left untouched)`);
  });

  it.skipIf(process.platform === 'win32')('does not follow an existing dangling symlink', () => {
    fs.mkdirSync(join(root, '.ai/cezar/workflows'), { recursive: true });
    const target = join(root, 'must-not-create');
    fs.symlinkSync(target, workflow);
    initCommand(root);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.lstatSync(workflow).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(skill)).toBe(true);
  });

  it('propagates write errors other than EEXIST', () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(fs.writeFileSync).mockImplementation(() => { throw error; });
    expect(() => initCommand(root)).toThrow(error);
  });
});
