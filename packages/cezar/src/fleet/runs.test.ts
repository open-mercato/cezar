import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { branchWebUrl, classifyRepo, cloneHttpsRepo, parseHttpsRepo } from './clone.ts';
import { createFleetRunHost, type BootProject } from './runs.ts';

const run = (id: string, status: string, fleetJobId?: string, fleetOpenPr?: boolean) => ({
  id, status, ...(fleetJobId ? { fleetJobId } : {}), ...(fleetOpenPr === undefined ? {} : { fleetOpenPr }),
});

describe('recover', () => {
  it('returns live fleet-tagged runs of the previous process, and nothing else', async () => {
    const cancelled: string[] = [];
    const boot = {
      root: '/boot',
      dataDir: '/boot/.ai/cezar',
      store: { listRuns: () => [run('a', 'waiting', 'job-1'), run('b', 'queued', 'job-2', false), run('c', 'running'), run('d', 'done', 'job-3')] },
      manager: { cancel: (id: string) => { cancelled.push(id); return true; } },
    } as unknown as BootProject;
    const host = createFleetRunHost({ boot, context: async () => boot });
    expect(await host.recover()).toEqual([
      { jobId: 'job-1', runId: 'a', openPr: true },
      { jobId: 'job-2', runId: 'b', openPr: false },
    ]);
    expect(cancelled).toEqual([]); // adoption, not cancellation
  });
});

describe('parseHttpsRepo', () => {
  it('accepts plain https repository URLs on any host, including subgroups and ports', () => {
    expect(parseHttpsRepo('https://gitlab.com/group/sub/repo.git')).toMatchObject({ url: 'https://gitlab.com/group/sub/repo.git', host: 'gitlab.com', segments: ['group', 'sub', 'repo'] });
    expect(parseHttpsRepo('https://git.example.org:8443/team/app')?.url).toBe('https://git.example.org:8443/team/app.git');
    expect(parseHttpsRepo('https://bitbucket.org/acme/demo/')?.segments).toEqual(['acme', 'demo']);
  });

  it.each([
    'http://gitlab.com/a/b', 'ssh://git@gitlab.com/a/b', 'git@gitlab.com:a/b.git', 'file:///etc/passwd', 'ext::sh -c id',
    '--upload-pack=x', 'https://user:pw@gitlab.com/a/b', 'https://user@gitlab.com/a/b', 'https://gitlab.com/a/b?x=1', 'https://gitlab.com/a/b#f',
    'https://gitlab.com/a', 'https://gitlab.com/a/../b', 'https://gitlab.com/a/b c', 'https://-evil.com/a/b', 'https://gitlab.com/-a/b', '/local/path', '',
  ])('refuses %j', (input) => {
    expect(parseHttpsRepo(input)).toBeNull();
  });
});

describe('classifyRepo', () => {
  it('routes GitHub spellings to gh, other https hosts to git, and refuses the rest', () => {
    expect(classifyRepo('acme/demo').kind).toBe('github');
    expect(classifyRepo('git@github.com:acme/demo.git').kind).toBe('github');
    expect(classifyRepo('https://gitlab.com/acme/demo').kind).toBe('https');
    expect(classifyRepo('ssh://git@gitlab.com/acme/demo').kind).toBe('invalid');
  });
});

describe('cloneHttpsRepo', () => {
  const repo = parseHttpsRepo('https://gitlab.com/acme/demo.git')!;
  it('clones into a folder named after the repo, then falls back to owner-repo when taken', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-clone-'));
    const urls: string[] = [];
    const ok = async (url: string) => { urls.push(url); return { ok: true as const }; };
    const first = await cloneHttpsRepo(repo, root, ok);
    expect(first).toEqual({ ok: true, target: join(root, 'demo') });
    const second = await cloneHttpsRepo(repo, root, ok);
    expect(second).toEqual({ ok: true, target: join(root, 'acme-demo') });
    expect(urls).toEqual(['https://gitlab.com/acme/demo.git', 'https://gitlab.com/acme/demo.git']);
  });

  it('removes the folder it made when the clone fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-clone-'));
    const out = await cloneHttpsRepo(repo, root, async () => ({ ok: false, error: 'not found' }));
    expect(out).toEqual({ ok: false, error: 'not found' });
    expect(existsSync(join(root, 'demo'))).toBe(false);
  });
});

describe('branchWebUrl', () => {
  it('derives a branch page for the common forges', () => {
    expect(branchWebUrl('https://gitlab.com/g/s/r.git', 'cez/ab12')).toBe('https://gitlab.com/g/s/r/-/tree/cez/ab12');
    expect(branchWebUrl('git@bitbucket.org:acme/demo.git', 'cez/x')).toBe('https://bitbucket.org/acme/demo/src/cez/x');
    expect(branchWebUrl('https://codeberg.org/acme/demo', 'cez/x')).toBe('https://codeberg.org/acme/demo/tree/cez/x');
  });
  it('is undefined for a local path', () => {
    expect(branchWebUrl('/srv/git/demo.git', 'cez/x')).toBeUndefined();
  });
});
