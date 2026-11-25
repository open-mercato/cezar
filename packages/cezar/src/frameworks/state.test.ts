import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { frameworkFileSchema } from '@open-mercato/cezar-contract';
import { SDD_APPROVAL_ENV, approveSdd, isStageApproved, mapFrameworkStageStatus, parseFrameworkStatus, readFrameworkState, scrubbedEnv } from './state.ts';
import { runPrecheck } from './card-runtime.ts';

describe('parseFrameworkStatus', () => {
  it('reads sdd.mjs status --json (stages as an object)', () => {
    const json = JSON.stringify({
      id: '2026-11-23-tax-rules',
      ui: true,
      stages: { discover: { status: 'done', at: 'x' }, spec: { status: 'approved', via: 'non-interactive' }, mockup: { status: 'stale' } },
      next: 'mockup',
      blockers: [],
    });
    expect(parseFrameworkStatus(json)).toEqual({ changeId: '2026-11-23-tax-rules', raw: { discover: 'done', spec: 'approved', mockup: 'stale' } });
  });

  it('reads stages as an array of { stage | name, status }, and a bare array', () => {
    expect(parseFrameworkStatus({ stages: [{ stage: 'spec', status: 'in_review' }, { name: 'verify', status: 'pending' }] })).toEqual({
      raw: { spec: 'in_review', verify: 'pending' },
    });
    expect(parseFrameworkStatus([{ stage: 'spec', status: 'done' }])).toEqual({ raw: { spec: 'done' } });
  });

  it('answers null for anything else', () => {
    expect(parseFrameworkStatus('not json')).toBeNull();
    expect(parseFrameworkStatus({ nothing: true })).toBeNull();
    expect(parseFrameworkStatus({ stages: { spec: { state: 'done' } } })).toBeNull();
  });

  it('maps statuses, and only approved/done/skipped advance a gate (D7)', () => {
    expect(mapFrameworkStageStatus('approved')).toBe('done');
    expect(mapFrameworkStageStatus('in_review')).toBe('waiting');
    expect(mapFrameworkStageStatus('in_progress')).toBe('running');
    expect(mapFrameworkStageStatus('stale')).toBe('stale');
    expect(mapFrameworkStageStatus('something-new')).toBe('pending');
    expect(['approved', 'done', 'skipped'].every(isStageApproved)).toBe(true);
    expect(['stale', 'pending', 'in_review', undefined].some(isStageApproved)).toBe(false);
  });
});

describe('state command and approveSdd', () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const changeId = '2026-11-23-tax-rules';

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cez-sdd-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, '.ai/sdd'), { recursive: true });
    mkdirSync(join(repo, '.ai/specs', changeId), { recursive: true });
    writeFileSync(join(repo, '.ai/specs', changeId, 'change.json'), '{"stages":{}}\n');
    // A fake sdd.mjs: records the env it saw, then writes change.json like `approve` does.
    writeFileSync(
      join(repo, '.ai/sdd/sdd.mjs'),
      [
        "import fs from 'node:fs';",
        "const [cmd, stage, change] = process.argv.slice(2);",
        "if (cmd === 'status') { console.log(JSON.stringify({ id: process.env.SDD_NONINTERACTIVE_APPROVAL ?? 'C', stages: { spec: { status: 'approved' }, mockup: { status: 'stale' } } })); process.exit(0); }",
        "fs.writeFileSync('env-seen.json', JSON.stringify({ approval: process.env.SDD_NONINTERACTIVE_APPROVAL ?? null, argv: process.argv.slice(2) }));",
        "if (process.env.SDD_NONINTERACTIVE_APPROVAL !== change) { console.error('approve needs a TTY'); process.exit(1); }",
        "if (!fs.existsSync(`.ai/specs/${change}`)) { console.error(`No change \"${change}\"`); process.exit(1); }",
        "fs.writeFileSync(`.ai/specs/${change}/change.json`, JSON.stringify({ stages: { [stage]: { status: 'approved', via: 'non-interactive' } } }));",
        "console.log(`Approved ${stage} for ${change}`);",
      ].join('\n'),
    );
    writeFileSync(join(repo, '.gitignore'), 'env-seen.json\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('approveSdd sets the approval variable on that spawn only, and commits change.json', async () => {
    expect(process.env[SDD_APPROVAL_ENV]).toBeUndefined();
    const res = await approveSdd(repo, 'spec', changeId, 'Ada');
    expect(res).toEqual({ ok: true, output: `Approved spec for ${changeId}` });
    const seen = JSON.parse(readFileSync(join(repo, 'env-seen.json'), 'utf8'));
    expect(seen).toEqual({ approval: changeId, argv: ['approve', 'spec', changeId, '--by', 'Ada'] });
    expect(process.env[SDD_APPROVAL_ENV]).toBeUndefined();
    expect(git('log', '-1', '--format=%s')).toContain(`sdd: approve spec for ${changeId} (by Ada, in cezar)`);
    expect(git('show', '--name-only', '--format=', 'HEAD').trim()).toBe(`.ai/specs/${changeId}/change.json`);
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('a refused approve leaves nothing committed and reports the script message', async () => {
    const res = await approveSdd(repo, 'spec', 'not-the-change', 'Ada');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('No change "not-the-change"');
    expect(git('log', '--format=%s').trim().split('\n')).toEqual(['init']);
  });

  it('rejects malformed stage and change ids before spawning anything', async () => {
    expect((await approveSdd(repo, 'spec; rm -rf /', changeId, 'Ada')).ok).toBe(false);
    expect((await approveSdd(repo, 'spec', '../x', 'Ada')).ok).toBe(false);
  });

  it('readFrameworkState runs state.command without the approval variable, even if cezar had one', async () => {
    const fw = frameworkFileSchema.parse({
      id: 'sdd', name: 'SDD', state: { command: 'node .ai/sdd/sdd.mjs status --json' },
      stages: [{ id: 'spec' }, { id: 'mockup' }, { id: 'verify' }],
    });
    process.env[SDD_APPROVAL_ENV] = 'leaked';
    try {
      const res = await readFrameworkState(fw.state!, fw.stages.map((st) => st.id), repo);
      expect(res).toMatchObject({ ok: true, stages: { spec: 'done', mockup: 'stale' }, status: { changeId: 'C' } });
      if (res.ok) expect(res.stages.verify).toBeUndefined();
      const out = execFileSync('node', ['.ai/sdd/sdd.mjs', 'status'], { cwd: repo, encoding: 'utf8', env: { ...process.env } });
      expect(JSON.parse(out).id).toBe('leaked'); // the fake does echo it when it IS inherited
    } finally {
      delete process.env[SDD_APPROVAL_ENV];
    }
  });

  it('readFrameworkState reports a failing or unreadable command as an error', async () => {
    const bad = frameworkFileSchema.parse({ id: 'x', name: 'X', state: { command: 'node -e "process.exit(3)"' }, stages: [{ id: 'a' }] });
    expect((await readFrameworkState(bad.state!, ['a'], repo)).ok).toBe(false);
    const noisy = frameworkFileSchema.parse({ id: 'x', name: 'X', state: { command: 'echo hello' }, stages: [{ id: 'a' }] });
    expect(await readFrameworkState(noisy.state!, ['a'], repo)).toMatchObject({ ok: false, error: expect.stringContaining('did not print a status') });
  });

  it('scrubbedEnv drops the approval and the tracker capability in any spelling, and nothing else', () => {
    const env = scrubbedEnv({ PATH: '/bin', Sdd_NonInteractive_Approval: 'x', cez_tracker_capability: 'y', [SDD_APPROVAL_ENV]: 'z', KEEP: '1' });
    expect(env).toEqual({ PATH: '/bin', KEEP: '1' });
    expect(scrubbedEnv({ cez_tracker_capability: 'y', sdd_noninteractive_approval: 'x' }, [SDD_APPROVAL_ENV])).toEqual({ cez_tracker_capability: 'y' });
  });

  it('state.command and the precheck never see the approval variable, whatever its case', async () => {
    const odd = 'Sdd_NonInteractive_Approval';
    process.env[odd] = 'leaked';
    try {
      const fw = frameworkFileSchema.parse({ id: 'sdd', name: 'SDD', state: { command: 'node .ai/sdd/sdd.mjs status --json' }, stages: [{ id: 'spec' }] });
      const echo = `node -e "if (Object.keys(process.env).some((k) => k.toUpperCase() === '${SDD_APPROVAL_ENV}')) process.exit(4)"`;
      expect((await readFrameworkState({ command: `${echo} && ${fw.state!.command}` }, ['spec'], repo)).ok).toBe(true);
      expect((await runPrecheck(echo, repo)).ok).toBe(true);
    } finally {
      delete process.env[odd];
    }
  });
});
