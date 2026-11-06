import { execFileSync } from 'node:child_process';
import { WebhookService } from '../webhooks/service.ts';
import { WebhookScheduler } from '../webhooks/scheduler.ts';
import type { ConversationDependencies } from './conversation.ts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTelegramTaskTarget } from './task-target.ts';
import { describe, expect, it, vi } from 'vitest';
import { createTelegramTask } from '../server/run-messages.ts';
import { unavailableProviderMessage, type JudgedProviderStatus } from '../server/provider-action-gate.ts';
import { randomUUID } from 'node:crypto';

const gate = (response: object) => unavailableProviderMessage(['codex'], response as JudgedProviderStatus)!;
const source = () => ({ id: randomUUID(), botId: '123', epoch: randomUUID(), projectId: 'project', receiverId: 'receiver', grantId: randomUUID(),
  grantGeneration: randomUUID(), enableGeneration: randomUUID(), chatId: '456', userId: '456', sourceMessageId: 1, updateId: 1,
  episodeId: randomUUID(), requestId: randomUUID(), runId: randomUUID(), state: 'claimed' as const, createdAt: 1, updatedAt: 1 });

describe('Telegram task source round trip', () => {
  it('forwards the prepared target through the webhook service adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telegram-adapter-'));
    execFileSync('git', ['init', '-q'], { cwd: root, timeout: 10_000 });
    vi.stubEnv('CEZ_WEBHOOKS', '1');
    const service = await WebhookService.open({ root, dataDir: join(root, '.ai', 'cezar'), projectId: 'project',
      mode: 'local', dryRun: true, serverPorts: () => [], scheduler: new WebhookScheduler() });
    try {
      expect(service).toBeDefined();
      const createTask = vi.fn(async () => ({ created: true as const, runId: 'run-1' }));
      service!.setTelegramInteractions({ context: vi.fn(), deliver: vi.fn(), createTask });
      const target = await prepareTelegramTaskTarget(root);
      const project = { root } as never, claimed = source(), check = () => undefined;
      // Exercise the exact dependencies the service handed to TelegramInbound, without starting polling.
      const inbound = service!.telegram as unknown as { deps: Pick<ConversationDependencies, 'createTask'> };
      await inbound.deps.createTask!(project, 'task', claimed, check, target);
      expect(createTask).toHaveBeenCalledExactlyOnceWith(project, 'task', claimed, check, target);
    } finally { await service?.dispose(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(['before', 'during', 'stable', 'unrelated settings'] as const)('binds the resolved account: %s', async timing => {
    const root = await mkdtemp(join(tmpdir(), 'telegram-account-'));
    vi.stubEnv('CEZ_HOME', join(root, 'home'));
    try {
      await mkdir(join(root, 'home'));
      await mkdir(join(root, '.ai', 'cezar'), { recursive: true });
      const config = join(root, '.ai', 'cezar', 'config.json');
      await writeFile(config, JSON.stringify({ defaultRunner: 'claude' }));
      const accounts = (path: string) => writeFile(join(root, 'home', 'agent-accounts.json'), JSON.stringify({
        accounts: [{ id: 'work', provider: 'claude', configDir: path }],
        selections: { [root]: { claude: 'work' } },
      }));
      await accounts('/account/approved');
      const target = await prepareTelegramTaskTarget(root);
      if (timing === 'before') await accounts('/account/changed');
      if (timing === 'unrelated settings') await writeFile(config, JSON.stringify({
        defaultRunner: 'claude', defaultModels: { claude: 'composer-only' }, namerModel: 'other',
      }));
      const startRun = vi.fn((_workflow: unknown, _input: unknown) => ({ id: 'run-1' }));
      const providerActionError = vi.fn(async () => {
        if (timing === 'during') await accounts('/account/changed');
        return null;
      });
      const result = await createTelegramTask({ root, manager: { startRun } } as never, 'task', source(),
        () => undefined, { providerActionError }, target);
      if (timing === 'before' || timing === 'during') {
        expect(startRun).not.toHaveBeenCalled();
        expect(result).toEqual({ created: false, reason: 'project_unavailable' });
      } else {
        expect(result.created).toBe(true);
        expect(startRun).toHaveBeenCalledExactlyOnceWith(expect.anything(),
          expect.objectContaining({ runner: 'claude', agentProfile: 'work' }));
        expect(startRun.mock.calls[0]?.[1]).not.toHaveProperty('model');
      }
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });

  it('uses the quick-task seam and refuses before creation when the provider gate blocks', async () => {
    const startRun = vi.fn(() => ({ id: 'run-1' }));
    const project = { root: '/missing-project', manager: { startRun } } as never;
    const blocked = await createTelegramTask(project, 'private prompt', source(), () => undefined, {
      providerActionError: async () => 'Codex credentials are unavailable.',
    }, await prepareTelegramTaskTarget('/missing-project'));
    expect(blocked).toEqual({ created: false, reason: 'provider_unavailable' });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('rechecks authorization after the account gate and creates exactly one run', async () => {
    const startRun = vi.fn(() => ({ id: 'run-1' }));
    const project = { root: '/missing-project', manager: { startRun } } as never;
    let valid = true;
    const claimed = source();
    const result = await createTelegramTask(project, 'private prompt', claimed, () => valid ? undefined : 'grant_changed', {
      providerActionError: async () => null,
    }, await prepareTelegramTaskTarget('/missing-project'));
    expect(result).toEqual({ created: true, runId: 'run-1' });
    expect(startRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ telegramSource: claimed }));
    expect(startRun).toHaveBeenCalledTimes(1);
    valid = false;
    expect(await createTelegramTask(project, 'private prompt', source(), () => 'grant_changed', { providerActionError: async () => null }, await prepareTelegramTaskTarget('/missing-project')))
      .toEqual({ created: false, reason: 'project_unavailable' });
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  // The gate's own refusals, so rewording one cannot silently change the Telegram reason (ARCH-4).
  it.each([
    [gate({ providers: [{ provider: 'codex', status: 'disconnected', profileId: 'work' }], accountLabels: { codex: 'work' } }), 'account_unavailable'],
    [gate({ providers: [{ provider: 'codex', status: 'disconnected' }] }), 'provider_unavailable'],
  ] as const)('returns a terminal policy result for %s', async (message, reason) => {
    const startRun = vi.fn();
    const result = await createTelegramTask({ root: '/missing-project', manager: { startRun } } as never,
      'private prompt', source(), () => undefined, { providerActionError: async () => message }, await prepareTelegramTaskTarget('/missing-project'));
    expect(result).toEqual({ created: false, reason }); expect(startRun).not.toHaveBeenCalled();
  });

  it('returns project_unavailable when the project/grant fence closes', async () => {
    const startRun = vi.fn();
    const result = await createTelegramTask({ root: '/missing-project', manager: { startRun } } as never,
      'private prompt', source(), () => 'project_changed', { providerActionError: async () => null }, await prepareTelegramTaskTarget('/missing-project'));
    expect(result).toEqual({ created: false, reason: 'project_unavailable' }); expect(startRun).not.toHaveBeenCalled();
  });
});
