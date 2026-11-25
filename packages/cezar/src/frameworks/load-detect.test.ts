import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { availabilitySummary, stageAvailability } from './availability.ts';
import { readProjectFrameworkChoice, writeProjectFrameworkChoice } from './choice.ts';
import { resolveProjectFramework } from './detect.ts';
import { frameworkHash, getFramework, listFrameworks } from './load.ts';

let repoRoot: string;
let dataDir: string;
const put = (rel: string, text = '') => {
  const path = join(repoRoot, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
};

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'cez-fw-'));
  dataDir = join(repoRoot, '.ai/cezar');
});
afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

describe('resolveProjectFramework (D6)', () => {
  it('falls back to Generic with nothing installed', () => {
    expect(resolveProjectFramework(repoRoot, dataDir)).toEqual({ id: 'generic', source: 'fallback' });
  });

  it('detects SDD from .ai/sdd/sdd.mjs', () => {
    put('.ai/sdd/sdd.mjs');
    expect(resolveProjectFramework(repoRoot, dataDir)).toEqual({ id: 'open-mercato-sdd', source: 'detected', detectedBy: '.ai/sdd/sdd.mjs' });
  });

  it('an explicit choice beats detection', () => {
    put('.ai/sdd/sdd.mjs');
    put('.ai/cezar/config.json', JSON.stringify({ framework: 'openspec' }));
    expect(resolveProjectFramework(repoRoot, dataDir)).toEqual({ id: 'openspec', source: 'explicit' });
  });

  it('an explicit generic beats detection too', () => {
    put('.ai/sdd/sdd.mjs');
    put('.ai/cezar/config.json', JSON.stringify({ framework: 'generic', maxParallel: 3 }));
    expect(resolveProjectFramework(repoRoot, dataDir)).toEqual({ id: 'generic', source: 'explicit' });
  });

  it('an explicit choice naming nothing that exists falls through to detection', () => {
    put('.ai/cezar/config.json', JSON.stringify({ framework: 'gone' }));
    expect(resolveProjectFramework(repoRoot, dataDir).source).toBe('fallback');
    put('.ai/cezar/frameworks/gone.yaml', 'id: gone');
    expect(resolveProjectFramework(repoRoot, dataDir)).toEqual({ id: 'gone', source: 'explicit' });
  });

  it('a malformed config.json reads as automatic', () => {
    put('.ai/cezar/config.json', '{ nope');
    expect(readProjectFrameworkChoice(dataDir)).toBeUndefined();
    expect(resolveProjectFramework(repoRoot, dataDir).source).toBe('fallback');
  });
});

describe('writeProjectFrameworkChoice', () => {
  it('merges into the raw config, keeps other keys, and null removes the key', async () => {
    put('.ai/cezar/config.json', JSON.stringify({ maxParallel: 3, custom: { a: 1 } }));
    await writeProjectFrameworkChoice(repoRoot, 'generic');
    expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))).toEqual({ maxParallel: 3, custom: { a: 1 }, framework: 'generic' });
    await writeProjectFrameworkChoice(repoRoot, null);
    expect(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))).toEqual({ maxParallel: 3, custom: { a: 1 } });
  });

  it('null with no config file creates nothing; a malformed file is never overwritten', async () => {
    await writeProjectFrameworkChoice(repoRoot, null);
    expect(() => readFileSync(join(dataDir, 'config.json'))).toThrow();
    put('.ai/cezar/config.json', '{ nope');
    await expect(writeProjectFrameworkChoice(repoRoot, 'generic')).rejects.toThrow();
    expect(readFileSync(join(dataDir, 'config.json'), 'utf8')).toBe('{ nope');
  });
});

describe('listFrameworks', () => {
  it('lists the four built-ins with no project dir', async () => {
    const list = await listFrameworks(repoRoot, dataDir);
    expect(list.map((f) => [f.id, f.source])).toEqual([
      ['open-mercato-sdd', 'builtin'],
      ['openspec', 'builtin'],
      ['spec-kit', 'builtin'],
      ['generic', 'builtin'],
    ]);
    expect(list.find((f) => f.id === 'openspec')?.framework?.provisional).toBe(true);
    expect(list.every((f) => f.hash === frameworkHash(f.yaml))).toBe(true);
  });

  it('lists an invalid project YAML with an error instead of throwing', async () => {
    put('.ai/cezar/frameworks/broken.yaml', 'id: broken\nname: Broken\nstages:\n  - { id: a, skill: s, command: /x }\n');
    put('.ai/cezar/frameworks/notyaml.yml', 'id: [unclosed');
    put('.ai/cezar/frameworks/generic.yaml', 'id: generic\nname: Mine\nstages: [ { id: a } ]\n');
    put('.ai/cezar/frameworks/misnamed.yaml', 'id: other\nname: Other\nstages: [ { id: a } ]\n');
    put('.ai/cezar/frameworks/ok.yaml', 'id: ok\nname: OK\nstages: [ { id: a, skill: s } ]\n');
    put('.ai/cezar/frameworks/README.md', 'not a framework');
    const list = await listFrameworks(repoRoot, dataDir);
    const project = list.filter((f) => f.source === 'project');
    expect(project.map((f) => f.id)).toEqual(['broken', 'generic', 'misnamed', 'notyaml', 'ok']);
    expect(project.find((f) => f.id === 'broken')?.error).toMatch(/exclusive/);
    expect(project.find((f) => f.id === 'notyaml')?.error).toMatch(/YAML/);
    expect(project.find((f) => f.id === 'generic')?.error).toMatch(/already taken/);
    expect(project.find((f) => f.id === 'misnamed')?.error).toMatch(/declares id "other"/);
    expect(project.find((f) => f.id === 'ok')).toMatchObject({ framework: { name: 'OK' } });
    expect(project.find((f) => f.id === 'ok')?.error).toBeUndefined();
    // The built-in keeps its id.
    expect((await getFramework(repoRoot, dataDir, 'generic'))?.source).toBe('builtin');
  });
});

describe('stageAvailability', () => {
  it('marks skills and commands present when the repo has them', async () => {
    put('.claude/skills/om-sdd-spec/SKILL.md', '---\nname: om-sdd-spec\n---\nbody');
    put('.claude/commands/openspec/apply.md', 'apply');
    const sdd = (await getFramework(repoRoot, dataDir, 'open-mercato-sdd'))!.framework!;
    const stages = await stageAvailability(sdd, repoRoot);
    expect(stages.find((s) => s.stage === 'spec')).toEqual({ stage: 'spec', kind: 'skill', name: 'om-sdd-spec', present: true });
    expect(stages.find((s) => s.stage === 'verify')?.present).toBe(false);
    expect(availabilitySummary(stages)).toEqual({ found: 1, total: 8 });

    const openspec = (await getFramework(repoRoot, dataDir, 'openspec'))!.framework!;
    const os = await stageAvailability(openspec, repoRoot);
    expect(os.map((s) => s.present)).toEqual([false, true, false]);

    const generic = (await getFramework(repoRoot, dataDir, 'generic'))!.framework!;
    expect((await stageAvailability(generic, repoRoot)).every((s) => s.kind === 'none' && s.present)).toBe(true);
  });
});
