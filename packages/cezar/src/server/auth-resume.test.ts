import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitAccountReconnected } from '../core/account-reconnected.ts';
import { registerAuthResume } from './auth-resume.ts';
import type { ProjectContext } from './project-context.ts';

/** The resumer's fan-out over projects and managers (spec 2026-11-18-inline-account-reconnect). */
describe('registerAuthResume', () => {
  const offs: Array<() => void> = [];
  afterEach(() => { for (const off of offs.splice(0)) off(); });

  function fakeContexts(ids: string[]) {
    const built = new Map<string, ProjectContext>();
    const listeners = new Set<(ctx: ProjectContext) => void>();
    const make = (id: string) => ({
      id,
      manager: { resumeAuthParked: vi.fn((_provider: string, _profileId: string, _before?: string) => [{ runId: `${id}-run`, title: `${id} task` }]) },
    }) as unknown as ProjectContext;
    for (const id of ids) built.set(id, make(id));
    return {
      contexts: {
        ids: () => [...built.keys()],
        peek: (id: string) => built.get(id),
        onContextBuilt: (listener: (ctx: ProjectContext) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      },
      build(id: string): ProjectContext {
        const ctx = make(id);
        built.set(id, ctx);
        for (const listener of listeners) listener(ctx);
        return ctx;
      },
      resumer: (id: string) => (built.get(id)!.manager as unknown as { resumeAuthParked: ReturnType<typeof vi.fn> }).resumeAuthParked,
    };
  }

  it('resumes parked runs in every built project and failed manager chats, and reports both', async () => {
    const fake = fakeContexts(['alpha', 'beta']);
    const managers = { resumeAuthFailed: vi.fn(() => [{ managerId: 'm1', title: 'Ops' }]) };
    offs.push(registerAuthResume({ contexts: fake.contexts, managers }));

    const resumed = await emitAccountReconnected({ provider: 'claude', profileId: 'work' });
    expect(resumed).toEqual({
      runs: [
        { projectId: 'alpha', runId: 'alpha-run', title: 'alpha task' },
        { projectId: 'beta', runId: 'beta-run', title: 'beta task' },
      ],
      managers: [{ managerId: 'm1', title: 'Ops' }],
    });
    expect(fake.resumer('alpha')).toHaveBeenCalledWith('claude', 'work', undefined);
    expect(managers.resumeAuthFailed).toHaveBeenCalledWith('claude', 'work');
  });

  it('a project built after the reconnect resumes only what parked before it', async () => {
    const fake = fakeContexts([]);
    offs.push(registerAuthResume({ contexts: fake.contexts }));
    await emitAccountReconnected({ provider: 'codex', profileId: 'default' });
    const late = fake.build('gamma');
    const resume = (late.manager as unknown as { resumeAuthParked: ReturnType<typeof vi.fn> }).resumeAuthParked;
    expect(resume).toHaveBeenCalledWith('codex', 'default', expect.any(String));
  });

  it('stops listening once disposed', async () => {
    const fake = fakeContexts(['alpha']);
    registerAuthResume({ contexts: fake.contexts })();
    expect(await emitAccountReconnected({ provider: 'claude', profileId: 'default' })).toEqual({ runs: [], managers: [] });
    expect(fake.resumer('alpha')).not.toHaveBeenCalled();
  });

  it('resumes the boot project, which never enters the lazy map', async () => {
    const fake = fakeContexts([]);
    const boot = { id: 'default', manager: { resumeAuthParked: vi.fn(() => [{ runId: 'b1', title: 'Boot task' }]) } } as unknown as ProjectContext;
    offs.push(registerAuthResume({ contexts: fake.contexts, boot: { context: boot, projectId: async () => 'demo-shop' } }));

    const resumed = await emitAccountReconnected({ provider: 'claude', profileId: 'default' });
    expect(resumed.runs).toEqual([{ projectId: 'demo-shop', runId: 'b1', title: 'Boot task' }]);
  });
});
