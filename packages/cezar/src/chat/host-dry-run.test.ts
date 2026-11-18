import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WebhookScheduler } from '../webhooks/scheduler.ts';
import { WebhookService } from '../webhooks/service.ts';
import { encodeSlackCredentials } from './providers/slack/identity.ts';
import { registerDeliveredChatSlot, vouchChatArtifact } from './registry.ts';
import type { ChatServiceDependencies } from './service.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });
const credentials = {
 telegram: `123456:${'A'.repeat(35)}`,
 slack: encodeSlackCredentials({ appToken: 'xapp-synthetic12345', botToken: 'xoxb-synthetic12345' }),
 discord: `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`,
};
async function open(provider: keyof typeof credentials, slot = false) {
 vi.stubEnv('CEZ_WEBHOOKS', '1');
 const root = await mkdtemp(join(tmpdir(), 'chat-dry-run-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
 execFileSync('git', ['init', '-q'], { cwd: root, timeout: 5000 });
 if (slot) {
  const artifact = { provider }; vouchChatArtifact('delivery', artifact);
  const declared = await registerDeliveredChatSlot(root, artifact); cleanups.push(declared.dispose);
 }
 const service = (await WebhookService.open({ root, dataDir: join(root, '.ai/cezar'), projectId: 'project', mode: 'local', serverPorts: () => [], scheduler: new WebhookScheduler(), dryRun: true }))!;
 cleanups.push(() => service.dispose());
 const { deps } = service[provider] as unknown as { deps: ChatServiceDependencies };
 return deps.credentialTransport!(credentials[provider]);
}
// With no artifact registered there is no transport to fall back to (spec 2026-11-09).
it.each(['telegram', 'slack', 'discord'] as const)('a dry run answers blocked for %s instead of reaching a platform', async provider => {
 await expect((await open(provider)).identify()).rejects.toMatchObject({ failure: { kind: 'blocked' } });
});
// A declared slot without a transport is a worker between restarts, so its bot backs off.
it.each(['telegram', 'slack', 'discord'] as const)('a declared %s slot without a transport answers transient', async provider => {
 await expect((await open(provider, true)).identify()).rejects.toMatchObject({ failure: { kind: 'transient' } });
});
