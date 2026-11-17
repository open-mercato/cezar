import { chatFailureSchema, type ChatFailure, chatIdentitySchema, chatMessageSchema, chatReceiptSchema, chatIdSchema, type ExtensionChatProvider } from '@open-mercato/cezar-contract'
import { z } from 'zod'
import { ChatReceiveServices } from './chat-session.ts'
import { receiveRetryDelay, type ChatConnectionOptions, type ChatConnection, type ReceiveJournal } from '../chat/connection.ts'
import { ChatTransportError, type ChatServiceDescriptor, type ChatTransport, type ChatMessage, type ChatReceipt } from '../chat/provider.ts'

type Invoke = (operation: string, input: unknown, options: {signal?: AbortSignal; valid: () => boolean; service?: (method: string, input: unknown) => Promise<unknown>}) => Promise<unknown>
/** No platform effects run in the host. Receive checkpoints belong to the existing core journal. */
export class ChatExtensionBridge implements ChatTransport {
  constructor(private readonly invoke: Invoke, private readonly valid: () => boolean, private readonly receiveModel: 'ordered' | 'opaque', private readonly textFormat?: ChatMessage['textFormat']) {}
  private async call(operation: string, input: unknown, signal?: AbortSignal, guard: () => boolean = () => true) {
    const valid = () => this.valid() && guard()
    if (!valid() || signal?.aborted) throw new ChatTransportError({ kind: 'blocked' })
    let result: unknown
    try { result = await this.invoke(operation, input, {signal,valid}) } catch (error) {
      if (!valid() || signal?.aborted) throw new ChatTransportError({kind:'blocked'})
      const failure = chatFailureSchema.safeParse(error && typeof error === 'object' && 'failure' in error ? error.failure : undefined)
      throw new ChatTransportError(failure.success ? failure.data : { kind: 'transient' })
    }
    if (!valid() || signal?.aborted) throw new ChatTransportError({ kind: 'blocked' })
    return result
  }
  async identify(signal?: AbortSignal) { return chatIdentitySchema.parse(await this.call('identify', {}, signal)) }
  async inspect(chatId: string) { return z.object({ id: chatIdSchema, kind: z.enum(['private', 'group']), eligible: z.boolean() }).parse(await this.call('inspect', { chatId })) }
  async send(chatId: string, message: ChatMessage, signal?: AbortSignal, valid?: () => boolean) {
    if (valid && !valid()) throw new ChatTransportError({ kind: 'blocked' })
    return chatReceiptSchema.parse(await this.call('send', { chatId, message: chatMessageSchema.parse({ ...message, ...(this.textFormat ? { textFormat: this.textFormat } : {}) }) }, signal, valid))
  }
  async clearButtons(receipt: ChatReceipt, signal?: AbortSignal) { await this.call('clearButtons', receipt, signal) }
  async acknowledge(eventId: string, text: string, signal?: AbortSignal) { await this.call('acknowledge', { eventId, text }, signal) }
  async isMember(chatId: string, userId: string, signal?: AbortSignal) { return z.boolean().optional().parse(await this.call('isMember', { chatId, userId }, signal)) }
  guarded(valid: () => boolean): ChatTransport { return new ChatExtensionBridge(this.invoke, () => this.valid() && valid(), this.receiveModel, this.textFormat) }
  connect(journal: ReceiveJournal, options: ChatConnectionOptions): ChatConnection {
    let controller = new AbortController()
    let stopped = true, run: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined
    let health: ReturnType<ChatConnection['health']> = { state: 'stopped' }
    let failures = 0
    const set = (state: typeof health.state) => { health = { state }; options.onHealth(health) }
    const loop = async () => {
      try {
        await journal.recover()
        while (!stopped && this.valid()) {
          const services = new ChatReceiveServices(journal, {...options, onHealth: value => { health = value; if (value.state === 'polling') failures = 0; options.onHealth(value) }}, controller.signal, () => !stopped && this.valid(), this.receiveModel)
          try {
            await this.invoke('receiveSession', {}, { signal: controller.signal, valid: () => !stopped && this.valid(), service: (method, input) => services.dispatch(method, input) })
            if (!stopped) set('blocked')
            return
          } catch (error) {
            if (stopped || !this.valid()) return
            // A worker restart, RPC timeout or adapter bug carries no ChatFailure: retry it, never end the bot.
            const parsed = chatFailureSchema.safeParse(error && typeof error === 'object' && 'failure' in error ? error.failure : undefined)
            const failure: ChatFailure = parsed.success ? parsed.data : { kind: 'transient' }
            if (!['transient','rate_limited'].includes(failure.kind)) {
              set(failure.kind === 'auth' ? 'credentials-unavailable' : failure.kind === 'conflict' ? 'conflict' : 'blocked')
              return
            }
            set('backoff')
            await new Promise<void>(resolve => {wake=resolve;timer=setTimeout(resolve,receiveRetryDelay(failure,++failures));timer.unref()})
          }
        }
      } catch { if (!stopped && this.valid()) set('blocked') }
    }
    return {
      start: () => { if (!stopped) return; stopped = false; controller = new AbortController(); set('polling'); run = loop() },
      stop: async () => { stopped = true; controller.abort(); clearTimeout(timer); wake?.(); await run; await journal.flush(); set('stopped') },
      health: () => health,
    }
  }
}

export function extensionChatDescriptor(extensionId: string, declaration: ExtensionChatProvider): ChatServiceDescriptor {
  const id = `${extensionId}/${declaration.id}`
  const formatText = (text: string, max = declaration.limits.maxText) => text.slice(0, max)
  return {
    id, pairingUsesIdentityUrl: !declaration.pairingLink, label: declaration.label, format: `${id}.v1`, credentials: declaration.credentials,
    ids: { bot: chatIdSchema, chat: chatIdSchema, user: chatIdSchema, message: chatIdSchema }, limits: declaration.limits,
    destination: () => declaration.discoveryUrl, credentialBotId: () => undefined,
    presentation: {
      label: declaration.label, maxText: declaration.limits.maxText, buttonTextLimit: 80, formatText,
      command: name => `${declaration.commandPrefix}${name}`, isGroup: chatId => chatId.startsWith(declaration.groupPrefix),
      discoveryLink: (username, code) => { if (declaration.pairingLink) return declaration.pairingLink.replaceAll('{username}', encodeURIComponent(username)).replaceAll('{code}', encodeURIComponent(code)); const url = new URL(declaration.discoveryUrl); url.searchParams.set('cezar_start', code); return url.href },
      taskReply: task => formatText([task.title, task.status, task.id, task.result, task.error, task.answer, task.excerpt,
        ...(task.questions ?? []).flatMap(question => [question.question, ...(question.options ?? []).map(option => option.label)]), ...Object.values(task.links ?? {})].filter(Boolean).join('\n')),
      sourceOutcome: () => 'Check the cockpit for the task outcome before trying again.',
    },
  }
}
