import { afterEach, describe, expect, it, vi } from 'vitest';
import { inRelayScope, runInRelayScope } from '../relay/scope.ts';
import type { ProjectContext } from './project-context.ts';

// Spec 2026-11-12-hosted-extensions §1: the cached per-project manager is process-wide, so the
// request that happens to build it first (a phone relay request) must not pin the relay's hosted view.
const retained: Array<{ mode: string; runtimeAllowed: boolean; inRelay: boolean }> = [];
vi.mock('../extensions/project-runtime.ts', () => ({
  retainProjectExtensions: vi.fn(async (project: { mode: string; runtimeAllowed: boolean }) => {
    retained.push({ mode: project.mode, runtimeAllowed: project.runtimeAllowed, inRelay: inRelayScope() });
    return { manager: { restore: vi.fn(async () => undefined) }, events: { publish: vi.fn() }, release: vi.fn(async () => undefined) };
  }),
}));

describe('the per-project extension manager under a phone relay request', () => {
  afterEach(() => { retained.length = 0; });

  it('is built with the cockpit\'s own mode and gate, outside the relay scope', async () => {
    const { restoreProjectExtensions, closeProjectExtensions } = await import('./extensions.ts');
    const project = {
      id: 'p1', root: '/tmp/p1', dataDir: '/tmp/p1/.ai/cezar',
      store: { listRuns: () => [], getRun: () => undefined, on: vi.fn(), off: vi.fn() },
    } as unknown as ProjectContext;
    // A local cockpit: capabilities narrow to hosted only inside a relay scope.
    const host = { local: () => !inRelayScope(), runtimeAllowed: () => !inRelayScope(), browseRoot: () => null };
    await runInRelayScope({ deviceId: 'phone-1' }, () => restoreProjectExtensions(project, () => undefined, host));
    expect(retained).toEqual([{ mode: 'local', runtimeAllowed: true, inRelay: false }]);
    await closeProjectExtensions(project);
  });
});
