import { expect, it, vi } from 'vitest';
import { deliverUserMessage } from './run-messages.ts';
import type { ProjectContext } from './project-context.ts';
import type { RunRecord } from '../runs/store.ts';

it('rechecks the Telegram grant after the asynchronous provider gate and before the first engine effect', async () => {
  const run = { id: 'run', status: 'waiting', runner: 'claude', steps: [] } as unknown as RunRecord;
  const sendMessage = vi.fn(() => true), enqueueMessage = vi.fn(), deferMessage = vi.fn();
  const project = { root: '/repo', dataDir: '/repo/.ai/cezar', store: { getRun: () => run }, manager: { sendMessage, enqueueMessage, deferMessage } } as unknown as ProjectContext;
  let valid = true;
  const result = await deliverUserMessage(project, run, { text: '[via Telegram] proceed', images: [] }, {
    async providerActionError() { await Promise.resolve(); valid = false; return null; },
    resolveAttachments: () => [], beforeEffect: () => valid ? undefined : 'grant_revoked',
  });
  expect(result).toEqual({ status: 409, body: { error: 'grant_revoked' } });
  expect(sendMessage).not.toHaveBeenCalled(); expect(enqueueMessage).not.toHaveBeenCalled(); expect(deferMessage).not.toHaveBeenCalled();
});
