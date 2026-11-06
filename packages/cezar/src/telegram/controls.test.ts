import { describe, expect, it, vi, afterEach } from 'vitest';
import { prepareTelegramControl } from './controls.ts';
import type { RunRecord } from '../runs/store.ts';
import type { ProjectContext } from '../server/project-context.ts';

function fixture() {
  const run = { id: 'task', status: 'done', runner: 'codex', agentProfile: 'current', steps: [
    { sessionId: 'session', backend: 'codex', profileId: 'old' },
  ] } as RunRecord;
  const continueRun = vi.fn(() => ({ ok: true })), cancel = vi.fn(() => true);
  const project = { root: '/nonexistent-telegram-project', store: { getRun: () => run }, manager: { continueRun, cancel } } as unknown as ProjectContext;
  const resolveProfile = vi.fn(async (_provider: unknown, _id?: string) => ({ profile: { id: 'current', path: '/account' } }));
  const providerActionError = vi.fn(async () => null as string | null);
  const deps = { resolveProfile, providerActionError, resolveAttachments: () => [] };
  return { run, project, deps, continueRun, cancel, resolveProfile, providerActionError };
}
afterEach(() => vi.unstubAllEnvs());
describe('Telegram saved configuration control bridge', () => {
  it('uses the current recorded account ahead of historical steps and leaves Auto unpinned', async () => {
    const x = fixture(), preview = await prepareTelegramControl(x.project, x.run, 'continue', 'hello', x.deps);
    expect(preview?.summary).toContain('Auto');
    expect(await preview?.execute(() => undefined)).toBe(true);
    expect(x.resolveProfile).toHaveBeenCalledWith('codex', 'current');
    expect(x.continueRun).toHaveBeenCalledWith('task', expect.objectContaining({ agentProfile: 'current', model: undefined, text: '[via Telegram] hello' }));
  });
  it('allows explicit default but refuses unknown account or runner without project fallback', async () => {
    const x = fixture(); x.run.agentProfile = 'default';
    expect(await prepareTelegramControl(x.project, x.run, 'continue', '', x.deps)).toBeDefined();
    delete x.run.agentProfile; x.run.steps = [];
    await expect(prepareTelegramControl(x.project, x.run, 'continue', '', x.deps)).rejects.toMatchObject({ reason: 'account_unknown' });
    x.run.agentProfile = 'default'; delete x.run.runner;
    expect(await prepareTelegramControl(x.project, x.run, 'continue', '', x.deps)).toBeUndefined();
    expect(x.continueRun).not.toHaveBeenCalled();
  });
  it('allows model policy lock, shows backend choice and invalidates a subsequent policy change', async () => {
    const x = fixture(); x.run.model = 'pinned'; vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '1');
    const preview = await prepareTelegramControl(x.project, x.run, 'continue', '', x.deps);
    expect(preview?.summary).toContain('Backend settings');
    expect(await preview?.execute(() => undefined)).toBe(true);
    vi.stubEnv('CEZ_AGENT_MODELS_LOCKED', '0');
    expect(preview?.valid()).toBe(false);
  });
  it.each(['model', 'agentProfile', 'status', 'session', 'archive'])('invalidates changed %s', async field => {
    const x = fixture(), preview = await prepareTelegramControl(x.project, x.run, 'continue', '', x.deps);
    if (field === 'model') x.run.model = 'changed';
    if (field === 'agentProfile') x.run.agentProfile = 'changed';
    if (field === 'status') x.run.status = 'running';
    if (field === 'session') x.run.steps[0]!.sessionId = 'changed';
    if (field === 'archive') x.run.archived = true;
    expect(await preview?.execute(() => undefined)).toBe(false); expect(x.continueRun).not.toHaveBeenCalled();
  });
  it('rechecks account mapping after auth, without disclosing account paths in preview', async () => {
    const x = fixture(), preview = await prepareTelegramControl(x.project, x.run, 'continue', '', x.deps);
    expect(preview?.summary).not.toContain('/account');
    x.resolveProfile.mockResolvedValueOnce({ profile: { id: 'current', path: '/changed' } });
    expect(await preview?.execute(() => undefined)).toBe(false); expect(x.continueRun).not.toHaveBeenCalled();
  });
  it('rechecks permission after asynchronous provider gates', async () => {
    const x = fixture(), preview = await prepareTelegramControl(x.project, x.run, 'continue', '', x.deps);
    let revoked = false;
    x.providerActionError.mockImplementationOnce(async () => { revoked = true; return null; });
    expect(await preview?.execute(() => revoked ? 'grant_changed' : undefined)).toBe(false);
    expect(x.continueRun).not.toHaveBeenCalled();
  });
  it('refuses unavailable provider at preview and again at execution', async () => {
    const x = fixture(); x.providerActionError.mockResolvedValueOnce('unavailable');
    expect(await prepareTelegramControl(x.project, x.run, 'continue', '', x.deps)).toBeUndefined();
    const preview = await prepareTelegramControl(x.project, x.run, 'continue', '', x.deps);
    x.providerActionError.mockResolvedValueOnce('unavailable');
    expect(await preview?.execute(() => undefined)).toBe(false); expect(x.continueRun).not.toHaveBeenCalled();
  });
  it('cancels only after a final guard and only while the preview matches', async () => {
    const x = fixture(); x.run.status = 'running';
    const preview = await prepareTelegramControl(x.project, x.run, 'cancel', '', x.deps);
    expect(x.cancel).not.toHaveBeenCalled();
    expect(await preview?.execute(() => 'revoked')).toBe(false);
    expect(await preview?.execute(() => undefined)).toBe(true);
    x.run.status = 'done'; expect(await preview?.execute(() => undefined)).toBe(false);
    expect(x.cancel).toHaveBeenCalledTimes(1);
  });
});
it('offers cancel for queued runs and refuses settled runs', async () => {
  const x = fixture(); x.run.status = 'queued';
  const queued = await prepareTelegramControl(x.project, x.run, 'cancel', '', x.deps);
  expect(await queued?.execute(() => undefined)).toBe(true);
  x.run.status = 'done'; expect(await prepareTelegramControl(x.project, x.run, 'cancel', '', x.deps)).toBeUndefined();
});
describe('Telegram control previews', () => {
  it('names the task by title and shows the exact follow-up text before Confirm', async () => {
    const x = fixture(); x.run.title = 'Fix the login test';
    const preview = await prepareTelegramControl(x.project, x.run, 'continue', 'also cover logout', x.deps);
    expect(preview?.summary.split('\n')[0]).toBe('Continue task task · Fix the login test?');
    expect(preview?.summary).toContain('Message:\nalso cover logout');
    const bare = await prepareTelegramControl(x.project, x.run, 'continue', '', x.deps);
    expect(bare?.summary).toContain('No message: the agent picks up where it stopped.');
    x.run.status = 'running';
    expect((await prepareTelegramControl(x.project, x.run, 'cancel', '', x.deps))?.summary).toBe('Cancel task task · Fix the login test?');
  });
});
