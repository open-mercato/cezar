import { bundledChatProvider, bundledChatProviders } from './bundled.ts';
import type { ChatServiceDescriptor, ChatProviderId, ChatTransport } from './provider.ts';
import { validateBundledProviderCollision } from './bundled.ts';

/** Bundled providers retain their IDs and state. External factories are project-scoped. */
export const chatProviders: readonly ChatServiceDescriptor[] = bundledChatProviders;
export type ChatTransportBinding = {id:string; revision:string}
// extensions/ verifies an artifact and vouches for it here, so chat/ never imports extensions/.
type VouchedArtifact = { readonly provider: string };
const vouched = { delivery: new WeakSet<object>(), selection: new WeakSet<object>() };
/** Host-only: call only after verifying the artifact's provenance and digest; registry.test.ts pins the callers. */
export function vouchChatArtifact(kind: keyof typeof vouched, artifact: VouchedArtifact): void { vouched[kind].add(artifact); }
export const isVouchedChatArtifact = (kind: keyof typeof vouched, artifact: object): boolean => vouched[kind].has(artifact);
type Registration = { activate?: () => Promise<void>; descriptor: ChatServiceDescriptor; transport?: (credential: string, valid?: () => boolean, binding?: ChatTransportBinding) => ChatTransport };
const projects = new Map<string, Map<string, Registration>>();
const listeners = new Map<string, Set<(id: ChatProviderId) => Promise<void>>>();
async function changed(scope: string, id: ChatProviderId) { await Promise.all([...listeners.get(scope) ?? []].map(listener => listener(id))); }
export async function registerChatExtension(scope: string, descriptor: ChatServiceDescriptor, transport: NonNullable<Registration['transport']>): Promise<() => Promise<void>> {
  if (!scope || !descriptor.id.includes('/') || descriptor.format !== `${descriptor.id}.v1`) throw Error('Extension chat providers require a project and extensionId/localId identifier');
  validateBundledProviderCollision(descriptor.id, descriptor.format);
  return register(scope,descriptor,transport);
}
/** Host-only alias for a durable, explicitly selected immutable installed artifact. */
export async function registerSelectedChatSlot(scope: string, artifact: VouchedArtifact, activate?: () => Promise<void>) {
  if (!scope || !isVouchedChatArtifact('selection', artifact)) throw Error('Unverified chat selection artifact');
  return registerCanonicalChatSlot(scope, artifact.provider, activate);
}
/** A verified declaration survives worker disable/failure; only its transport changes. */
export async function registerDeliveredChatSlot(scope: string, artifact: VouchedArtifact, activate?: () => Promise<void>) {
  if (!scope || !isVouchedChatArtifact('delivery', artifact)) throw Error('Unverified chat delivery artifact');
  return registerCanonicalChatSlot(scope, artifact.provider, activate);
}
async function registerCanonicalChatSlot(scope: string, provider: string, activate?: () => Promise<void>) {
  const descriptor = bundledChatProvider(provider);
  if (!descriptor) throw Error('Unknown canonical provider');
  const dispose = await register(scope, descriptor, undefined);
  const registration = projects.get(scope)!.get(descriptor.id)!;
  registration.activate = activate;
  return { dispose, async setTransport(transport: Registration['transport']) {
    if (projects.get(scope)?.get(descriptor.id) !== registration) throw Error('Chat declaration retired');
    registration.transport = transport;
    await changed(scope, descriptor.id);
  } };
}
export const chatTransportAvailable = (scope: string, id: ChatProviderId): boolean => !!projects.get(scope)?.get(id)?.transport;
/** Called only by active setup/delivery/start paths, never by metadata reads. */
export async function ensureChatTransport(scope: string, id: ChatProviderId): Promise<void> {
  const registration = projects.get(scope)?.get(id);
  if (!registration || registration.transport) return;
  await registration.activate?.();
  if (projects.get(scope)?.get(id) !== registration) throw Error('Chat declaration retired');
}
async function register(scope: string, descriptor: ChatServiceDescriptor, transport: Registration['transport']): Promise<() => Promise<void>> {
  const providers = projects.get(scope) ?? new Map<string, Registration>();
  if (providers.has(descriptor.id)) throw Error(`Chat provider already registered: ${descriptor.id}`);
  projects.set(scope, providers);
  const registration: Registration = { descriptor, transport };
  providers.set(descriptor.id, registration);
  const dispose = async () => {
    if (providers.get(descriptor.id) !== registration) return;
    providers.delete(descriptor.id);
    if (!providers.size) projects.delete(scope);
    await changed(scope, descriptor.id);
  };
  try { await changed(scope, descriptor.id); } catch (error) { await dispose(); throw error; }
  return dispose;
}
export function watchChatExtensions(scope: string, listener: (id: ChatProviderId) => Promise<void>): () => void {
  const set = listeners.get(scope) ?? new Set(); listeners.set(scope, set); set.add(listener);
  return () => { set.delete(listener); if (!set.size) listeners.delete(scope); };
}
export function projectChatExtensions(scope: string): ChatServiceDescriptor[] { return [...projects.get(scope)?.values() ?? []].map(item => item.descriptor); }
export const chatProvider = (id: ChatProviderId, scope?: string): ChatServiceDescriptor | undefined =>
  (scope ? projects.get(scope)?.get(id)?.descriptor : undefined) ?? bundledChatProvider(id);
export const chatTransport = (scope: string, id: ChatProviderId, credential: string, valid?: () => boolean, binding?: ChatTransportBinding): ChatTransport | undefined => projects.get(scope)?.get(id)?.transport?.(credential, valid, binding);

const selectionListeners = new Map<string, Set<(id: ChatProviderId, enabled: boolean) => Promise<void>>>();
/** Explicit selection changes, separate from worker activation/crash notifications. */
export function watchChatAdapterSelection(scope: string, listener: (id: ChatProviderId, enabled: boolean) => Promise<void>): () => void {
  const listeners = selectionListeners.get(scope) ?? new Set();
  selectionListeners.set(scope, listeners); listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) selectionListeners.delete(scope); };
}
export function hasChatSelectionOwner(scope: string): boolean { return !!selectionListeners.get(scope)?.size; }
export async function setChatAdapterEnabled(scope: string, id: ChatProviderId, enabled: boolean): Promise<void> {
  const listeners = selectionListeners.get(scope);
  if (!listeners?.size) throw Error('Chat host unavailable for a durable selection change');
  for (const listener of listeners) await listener(id, enabled);
}
