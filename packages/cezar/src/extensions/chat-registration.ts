import { randomUUID } from 'node:crypto'
import { chatCredentialsSchema, type ExtensionChatProvider, type ExtensionRecord } from '@open-mercato/cezar-contract'
import { ChatTransportError } from '../chat/provider.ts'
import { bundledChatProvider } from '../chat/bundled.ts'
import { chatCredentialProfile } from '../chat/credential-profiles.ts'
import { registerChatExtension } from '../chat/registry.ts'
import { ChatExtensionBridge, extensionChatDescriptor } from './chat-bridge.ts'
import type { ExtensionHostContext } from './context.ts'
import type { ExtensionCallOptions } from './host.ts'
import type { ExtensionManager } from './manager.ts'
import { extensionChatCallSchema } from './protocol.ts'

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

/** A stored chat credential that does not parse is a permanent fault, never a transient retry. */
function parseChatCredential(credential: string): Record<string, string> {
  try {
    return chatCredentialsSchema.parse(JSON.parse(credential))
  } catch {
    throw new ChatTransportError({ kind: 'auth' })
  }
}

export function registerChat(manager: ExtensionManager, record: ExtensionRecord, declaration: ExtensionChatProvider, context: ExtensionHostContext) {
  const id = record.manifest.id
  const descriptor = extensionChatDescriptor(id, declaration)
  const candidate = manager.chatSlots.get(id)?.artifact
  const artifact = candidate && (candidate.origin === 'installed' ? candidate.localProviderId : candidate.provider) === declaration.id ? candidate : undefined
  const bindings = new Map<string, { revision: string; handle: string; ready: Promise<unknown> }>()
  const scope = { kind: 'project' as const, projectId: manager.projectId, root: manager.projectRoot }
  const profile = declaration.credentialProfile ? chatCredentialProfile(declaration.credentialProfile, scope, manager.secrets, manager.home) : undefined
  const native = artifact ? bundledChatProvider(artifact.provider) : undefined
  const invoke = async (botHandle: string, credential: string, operation: string, input: unknown, options: ExtensionCallOptions) => {
    const workerCredential = native?.adapterCredential?.(credential) ?? credential
    const credentials = parseChatCredential(workerCredential)
    for (const field of declaration.credentials) {
      const value = credentials[field.name]
      if (field.secret && value) context.rememberSecret(value)
    }
    try {
      const safeCredential = declaration.credentialProfile ? '{}' : workerCredential
      const cancelled = () => options.signal?.aborted || options.valid?.() === false
      const service = async (method: string, input: unknown) => {
        await manager.assertCurrent(record)
        if (cancelled()) throw new ChatTransportError({ kind: 'blocked' })
        if (method === 'accessToken') {
          const validSlot = input && typeof input === 'object' && 'slot' in input && (input.slot === 'app' || input.slot === 'bot') && Object.keys(input).length === 1
          if (!profile || !validSlot) throw new ChatTransportError({ kind: 'blocked' })
          const token = await profile.accessToken(credential, (input as { slot: 'app' | 'bot' }).slot, options.signal, options.valid)
          context.rememberSecret(token)
          await manager.assertCurrent(record)
          if (cancelled()) throw new ChatTransportError({ kind: 'blocked' })
          return token
        }
        if (!options.service) throw new ChatTransportError({ kind: 'blocked' })
        return options.service(method, input)
      }
      const call = extensionChatCallSchema.parse({
        providerId: declaration.id, botHandle,
        ...(declaration.credentialProfile ? { credentialProfile: declaration.credentialProfile } : {}),
        credential: safeCredential, operation, input,
      })
      const callOptions = { ...options, service, authorize: () => manager.assertCurrent(record) }
      return context.redact(await (operation === 'receiveSession' ? manager.host.receiveSession(id, call, callOptions) : manager.host.chat(id, call, callOptions)))
    } catch (error) {
      if (error && typeof error === 'object' && 'failure' in error) throw error
      throw new Error(context.redact(errorMessage(error, 'Chat operation failed')))
    }
  }
  const retire = (botHandle: string, options?: ExtensionCallOptions) =>
    manager.host.chat(id, { providerId: declaration.id, botHandle, credential: '{}', operation: 'retire', input: {} }, options)
  const register: typeof registerChatExtension = artifact
    ? async (_scope, _descriptor, factory) => {
      const registration = manager.chatSlots.get(id)!.registration
      await registration.setTransport(factory)
      return () => registration.setTransport(undefined)
    }
    : registerChatExtension
  return register(manager.projectRoot, descriptor, (credential, valid = () => true, binding) => {
    let selected = binding ? bindings.get(binding.id) : undefined
    if (!selected || selected.revision !== binding?.revision) {
      const prior = selected
      selected = {
        revision: binding?.revision ?? '',
        handle: randomUUID(),
        ready: prior ? prior.ready.then(() => retire(prior.handle, { authorize: () => manager.assertCurrent(record) })) : Promise.resolve(),
      }
      void selected.ready.catch(() => undefined)
      if (binding) bindings.set(binding.id, selected)
    }
    const botHandle = selected.handle
    const bindingCurrent = () => !binding || bindings.get(binding.id) === selected
    return new ChatExtensionBridge(
      async (operation, input, options) => {
        await selected.ready
        if (binding) return invoke(botHandle, credential, operation, input, options)
        // Setup operations have no durable bot binding. Their adapter belongs to
        // this call only, including its full receive session, and is always retired.
        const temporary = randomUUID()
        try { return await invoke(temporary, credential, operation, input, options) }
        finally { await retire(temporary).catch(() => undefined) }
      },
      () => !manager.closed && manager.contexts.get(id) === context && bindingCurrent() && valid(),
      declaration.receiveModel, native?.textFormat,
    )
  })
}
