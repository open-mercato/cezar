import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runImpactCommand, type ImpactCliContext } from './impact-cli.ts';
import { fixtureRepo, type FixtureRepo } from './fixture-repo.testkit.ts';

const ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));
// Resolved here, not from the fixture cwd, where no node_modules exists.
const TSX = import.meta.resolve('tsx');
let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

function context(cwd: string, artifacts?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: ImpactCliContext = {
    cwd,
    env: artifacts ? { CEZ_ARTIFACTS_DIR: artifacts } : {},
    log: (l) => out.push(l),
    error: (l) => err.push(l),
  };
  return { ctx, out, err };
}

function twoCommits(r: FixtureRepo) {
  r.write('src/index.ts', 'export const a = 1;\n');
  const base = r.commit('base');
  r.write('src/index.ts', 'export const a = 2;\n');
  return { base, head: r.commit('head') };
}

describe('runImpactCommand', () => {
  it('render --demo writes the report into $CEZ_ARTIFACTS_DIR and says ok', async () => {
    repo = fixtureRepo();
    const artifacts = join(repo.root, 'artifacts');
    const { ctx, out, err } = context(repo.root, artifacts);
    expect(await runImpactCommand(['render', '--demo'], ctx)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([`ok: ${join(artifacts, 'impact-demo.html')} (2 views)`]);
    expect(readFileSync(join(artifacts, 'impact-demo.html'), 'utf8')).toContain('Created by the Open Mercato Team');
  });

  it('render reads review.json and writes impact.html by default; falls back to cwd without CEZ_ARTIFACTS_DIR', async () => {
    repo = fixtureRepo();
    const demo = JSON.parse(readFileSync(new URL('./demo-review.json', import.meta.url), 'utf8'));
    writeFileSync(join(repo.root, 'review.json'), JSON.stringify(demo));
    const { ctx, out } = context(repo.root);
    expect(await runImpactCommand(['render'], ctx)).toBe(0);
    expect(out[0]).toBe(`ok: ${join(repo.root, 'impact.html')} (2 views)`);
    expect(existsSync(join(repo.root, 'impact.html'))).toBe(true);
  });

  it('render says how many elements changed since the previous version', async () => {
    repo = fixtureRepo();
    const demo = JSON.parse(readFileSync(new URL('./demo-review.json', import.meta.url), 'utf8'));
    writeFileSync(join(repo.root, 'review.json'), JSON.stringify(demo));
    const { ctx, out } = context(repo.root);
    expect(await runImpactCommand(['render'], ctx)).toBe(0);
    expect(await runImpactCommand(['render'], ctx)).toBe(0);
    demo.capabilities[0].title = 'Edited';
    writeFileSync(join(repo.root, 'review.json'), JSON.stringify(demo));
    expect(await runImpactCommand(['render'], ctx)).toBe(0);
    demo.tradeoffs.splice(0, 1);
    demo.fit[0].status = 'tension';
    writeFileSync(join(repo.root, 'review.json'), JSON.stringify(demo));
    expect(await runImpactCommand(['render'], ctx)).toBe(0);
    const html = join(repo.root, 'impact.html');
    expect(out).toEqual([
      `ok: ${html} (2 views)`,
      `ok: ${html} (2 views) · 0 changes since v1`,
      `ok: ${html} (2 views) · 1 change since v2`,
      `ok: ${html} (2 views) · 2 changes since v3`,
    ]);
  });

  it('an invalid model exits 1 with one issue per line and writes nothing', async () => {
    repo = fixtureRepo();
    const demo = JSON.parse(readFileSync(new URL('./demo-review.json', import.meta.url), 'utf8'));
    demo.capabilities[0].evidence = ['missing'];
    demo.architecture.views[0].places[1].col = 0;
    writeFileSync(join(repo.root, 'review.json'), JSON.stringify(demo));
    const { ctx, out, err } = context(repo.root);
    expect(await runImpactCommand(['render', '--input', 'review.json', '--out', 'x.html'], ctx)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toContain('capabilities[0].evidence[0]: unresolved evidence missing');
    expect(err.some((l) => l.includes('same grid cell'))).toBe(true);
    expect(existsSync(join(repo.root, 'x.html'))).toBe(false);
  });

  it('unreadable or non-JSON input exits 1; usage errors exit 2', async () => {
    repo = fixtureRepo();
    const { ctx, err } = context(repo.root);
    expect(await runImpactCommand(['render'], ctx)).toBe(1);
    expect(err[0]).toMatch(/cannot read the review model/);
    writeFileSync(join(repo.root, 'review.json'), '{ nope');
    expect(await runImpactCommand(['render'], ctx)).toBe(1);
    expect(await runImpactCommand(['render', '--bogus'], ctx)).toBe(2);
    expect(await runImpactCommand(['render', '--demo', '--input', 'a.json'], ctx)).toBe(2);
    expect(await runImpactCommand(['evidence'], ctx)).toBe(2);
    expect(await runImpactCommand(['evidence', '--pr', '1', '--spec', 'x.md'], ctx)).toBe(2);
    expect(await runImpactCommand(['evidence', '--base', 'main'], ctx)).toBe(2);
    expect(await runImpactCommand(['frobnicate'], ctx)).toBe(2);
    expect(await runImpactCommand([], ctx)).toBe(2);
    expect(await runImpactCommand(['--help'], ctx)).toBe(0);
  });

  it('evidence writes evidence.json for a range; a missing ref exits 1', async () => {
    repo = fixtureRepo();
    const { base, head } = twoCommits(repo);
    const artifacts = join(repo.root, '.art');
    const { ctx, out, err } = context(repo.root, artifacts);
    expect(await runImpactCommand(['evidence', '--base', base, '--head', 'HEAD'], ctx)).toBe(0);
    expect(out[0]).toMatch(/^ok: .*evidence\.json — 1 changed files at [0-9a-f]{12}, 1 public surface candidates$/);
    const evidence = JSON.parse(readFileSync(join(artifacts, 'evidence.json'), 'utf8'));
    expect(evidence.comparison.head).toBe(head);
    expect(await runImpactCommand(['evidence', '--base', 'no-such-ref', '--head', 'HEAD'], ctx)).toBe(1);
    expect(err.at(-1)).toMatch(/not available locally/);
  });
});

// The real entry point, as an agent runs it: no cockpit, no CEZ_API_URL.
describe('cez impact (process)', () => {
  const cli = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      execFile(process.execPath, ['--import', TSX, ENTRY, 'impact', ...args], { cwd, env }, (error, stdout, stderr) => {
        done({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr });
      });
    });
  const env = () => {
    const e: NodeJS.ProcessEnv = { ...process.env };
    delete e.CEZ_API_URL;
    delete e.CEZ_PROJECT_ID;
    delete e.CEZ_ARTIFACTS_DIR;
    return e;
  };

  it('evidence and render work with no CEZ_API_URL, with the documented exit codes', async () => {
    repo = fixtureRepo();
    const { base } = twoCommits(repo);
    const artifacts = join(repo.root, 'artifacts');
    const ev = await cli(['evidence', '--base', base, '--head', 'HEAD'], repo.root, { ...env(), CEZ_ARTIFACTS_DIR: artifacts });
    expect(ev.code, ev.stderr).toBe(0);
    expect(existsSync(join(artifacts, 'evidence.json'))).toBe(true);
    const demo = await cli(['render', '--demo', '--out', 'demo.html'], repo.root, env());
    expect(demo.code, demo.stderr).toBe(0);
    expect(demo.stdout.trim()).toMatch(/^ok: .*\/demo\.html \(2 views\)$/);
    expect(existsSync(join(repo.root, 'demo.html'))).toBe(true);
    writeFileSync(join(repo.root, 'review.json'), '{"schema_version":4}');
    const bad = await cli(['render'], repo.root, env());
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/^meta: /m);
    const usage = await cli(['render', '--nope'], repo.root, env());
    expect(usage.code).toBe(2);
  }, 60_000);
});
