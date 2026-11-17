import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { registerChatExtension, registerDeliveredChatSlot, registerSelectedChatSlot, chatProvider, vouchChatArtifact } from './registry.ts';
import { bundledChatProviders } from './bundled.ts';

describe('chat provider registry', async () => {
  it('keeps the shipped providers in a distinct bundled catalog', () => {
    expect(bundledChatProviders.map(provider => provider.id)).toEqual(['telegram'])
    expect(chatProvider('telegram')?.format).toBe('telegram.v1')
  })
  it('registers and removes an extension provider without changing built-ins', async () => {
    const descriptor = { id: 'acme/relay' as const, label: 'Relay', format: 'acme/relay.v1', credentials: [], ids: { bot: {} as never, chat: {} as never, user: {} as never, message: {} as never }, presentation: {} as never, limits: { maxText: 100, buttonsPerMessage: 1, perChatPerSecond: 1, perBotPerSecond: 1 }, destination: (value: string) => value, credentialBotId: () => undefined };
    const dispose = await registerChatExtension('/project-a', descriptor, () => ({}) as never);
    expect(chatProvider('telegram')?.format).toBe('telegram.v1');
    expect(chatProvider('acme/relay', '/project-a')?.label).toBe('Relay');
    await dispose();
    expect(chatProvider('acme/relay', '/project-a')).toBeUndefined();
  });
  it('refuses canonical aliases inferred from names or forged catalog metadata', async () => {
    await expect(registerDeliveredChatSlot('/project-a',{provider:'telegram',extensionId:'open-mercato.telegram',integrity:'sha512-forged'} as never)).rejects.toThrow('Unverified');
  });
  it('keeps a selection voucher from granting a delivered alias, and the reverse', async () => {
    const selected = Object.freeze({ provider: 'telegram' }), delivered = Object.freeze({ provider: 'telegram' });
    vouchChatArtifact('selection', selected); vouchChatArtifact('delivery', delivered);
    await expect(registerDeliveredChatSlot('/project-v', selected)).rejects.toThrow('Unverified');
    await expect(registerSelectedChatSlot('/project-v', delivered)).rejects.toThrow('Unverified');
  });
  it('rejects duplicate extension IDs', async () => {
    const descriptor = { id: 'acme/duplicate' as const, label: 'Duplicate', format: 'acme/duplicate.v1', credentials: [], ids: { bot: {} as never, chat: {} as never, user: {} as never, message: {} as never }, presentation: {} as never, limits: { maxText: 100, buttonsPerMessage: 1, perChatPerSecond: 1, perBotPerSecond: 1 }, destination: (value: string) => value, credentialBotId: () => undefined };
    const dispose = await registerChatExtension('/project-a', descriptor, () => ({}) as never);
    await expect(registerChatExtension('/project-a', descriptor, () => ({}) as never)).rejects.toThrow('already registered');
    await dispose();
  });
});

// The vouch grants canonical provider IDs, so only the two verifying modules may call it (spec 2026-11-09).
it('lets only the artifact verifiers vouch for a chat artifact', () => {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const callers = (readdirSync(src, { recursive: true }) as string[])
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts'))
    .filter(file => /\bvouchChatArtifact\s*\(/.test(readFileSync(join(src, file), 'utf8')))
    .map(file => file.split('\\').join('/')).sort();
  expect(callers).toEqual(['chat/registry.ts', 'extensions/chat-selection-store.ts', 'extensions/delivery-catalog.ts']);
});
