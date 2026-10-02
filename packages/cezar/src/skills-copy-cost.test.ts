import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      reads.push(String(path));
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
  };
});

const { copyProjectSkills, skillCopyMatches } = await import('./skills-remote.ts');

describe('skillCopyMatches — cost on the event loop', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-skill-cost-'));
    mkdirSync(join(root, 'source/assets'), { recursive: true });
    writeFileSync(join(root, 'source/SKILL.md'), '---\nname: demo\n---\nbody\n');
    writeFileSync(join(root, 'source/assets/big.bin'), Buffer.alloc(1024 * 1024, 7));
    cpSync(join(root, 'source'), join(root, 'copy'), { recursive: true });
    reads.length = 0;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const assetReads = () => reads.filter((path) => path.endsWith('big.bin')).length;

  it('never reads an asset on the event loop for the first delivery after a copy or a rebuild', async () => {
    const wt = join(root, 'wt');
    mkdirSync(wt);
    execFileSync('git', ['init', '-q'], { cwd: wt });
    writeFileSync(join(wt, '.gitignore'), '.agents/\n.claude/skills\n');
    const skill = { name: 'demo', body: '', path: join(root, 'source/SKILL.md'), source: 'agents' as const };
    const copy = join(wt, '.agents/skills/demo');

    expect(await copyProjectSkills(wt, [skill])).toContain('.agents/skills/demo');
    reads.length = 0;
    expect(skillCopyMatches(copy, join(root, 'source'))).toBe(true);
    expect(assetReads()).toBe(0);

    writeFileSync(join(copy, 'assets/big.bin'), Buffer.alloc(1024 * 1024, 9));
    expect(await copyProjectSkills(wt, [skill])).toContain('.agents/skills/demo');
    reads.length = 0;
    expect(skillCopyMatches(copy, join(root, 'source'))).toBe(true);
    expect(assetReads()).toBe(0);
  });

  it('reads a large asset at most once per side, then only stats it while it is unchanged', () => {
    expect(skillCopyMatches(join(root, 'copy'), join(root, 'source'))).toBe(true);
    const first = assetReads();
    expect(first).toBeLessThanOrEqual(2);
    expect(skillCopyMatches(join(root, 'copy'), join(root, 'source'))).toBe(true);
    expect(skillCopyMatches(join(root, 'copy'), join(root, 'source'))).toBe(true);
    expect(assetReads()).toBe(first);
  });

  it('settles a size mismatch without reading any content', () => {
    writeFileSync(join(root, 'copy/assets/big.bin'), Buffer.alloc(1024, 7));
    expect(skillCopyMatches(join(root, 'copy'), join(root, 'source'))).toBe(false);
    expect(assetReads()).toBe(0);
  });

  it('still catches a same-size edit, even one that restores the mtime', async () => {
    expect(skillCopyMatches(join(root, 'copy'), join(root, 'source'))).toBe(true);
    const { statSync, utimesSync } = await import('node:fs');
    const file = join(root, 'copy/assets/big.bin');
    const before = statSync(file);
    writeFileSync(file, Buffer.alloc(1024 * 1024, 8));
    utimesSync(file, before.atime, before.mtime);
    expect(skillCopyMatches(join(root, 'copy'), join(root, 'source'))).toBe(false);
  });
});
