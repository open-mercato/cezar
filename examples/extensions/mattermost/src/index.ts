import { ExtensionChatError, defineExtension, type ExtensionChatAdapter, type ExtensionChatOperationContext, type ChatReceipt } from '@open-mercato/cezar-extension-sdk'

import { receivePage, type Channel, type Post } from './paging.js'

type User = { id: string; username: string }
const rawId = (id: string) => {
  const raw = id.replace(/^(private|group):/, '')
  if (!/^[a-z0-9]{26}$/.test(raw)) throw Error('Invalid Mattermost identifier')
  return raw
}
/** Waits between empty polls; an abort ends the wait at once. */
const idle = (signal: ExtensionChatOperationContext['signal']) => new Promise<void>(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  const timer = setTimeout(done, 500)
  signal.addEventListener('abort', done, { once: true })
})
export default defineExtension({
  activate(context) {
    return context.chat.register('chat', credentials => {
      const server = new URL(credentials.server!)
      if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash) throw Error('Use a Mattermost HTTPS server URL')
      const base = server.origin
      const headers = { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' }
      const started = Date.now()
      const abort = new AbortController()
      async function request<T>(path: string, body: unknown, method: 'GET' | 'POST', signal: AbortSignal | undefined, operation: ExtensionChatOperationContext): Promise<T> {
        const controller = new AbortController()
        const onAbort = () => controller.abort()
        const requestSignal = AbortSignal.any([abort.signal, controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(20_000)])
        const options = { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal }
        operation.signal.addEventListener('abort', onAbort, { once: true })
        try {
          // Recheck after preparation for EVERY request, including later receive pages.
          await operation.assertActive()
          operation.signal.throwIfAborted()
          requestSignal.throwIfAborted()
          const response = await fetch(`${base}/api/v4${path}`, options)
          if (!response.ok) throw new ExtensionChatError({ kind: response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate_limited' : response.status === 404 ? 'gone' : 'transient', ...(response.status === 429 ? { retryAfterMs: Math.max(1000, Number(response.headers.get('retry-after') ?? 1) * 1000) } : {}) })
          // Keep cancellation connected until the response body has been consumed.
          return await response.json() as T
        } finally {
          operation.signal.removeEventListener('abort', onAbort)
        }
      }
      let me: User | undefined
      const identity = async (signal: AbortSignal | undefined, operation: ExtensionChatOperationContext) => me ??= await request<User>('/users/me', undefined, 'GET', signal, operation)
      const channels = async (signal: AbortSignal | undefined, operation: ExtensionChatOperationContext) => (await request<Channel[]>(`/users/${(await identity(signal, operation)).id}/channels`, undefined, 'GET', signal, operation)).filter(channel => !channel.delete_at).slice(0, 20)
      const kind = (channel: Channel) => channel.type === 'D' ? 'private' as const : 'group' as const
      // Ephemeral like core actions: restart invalidates pending confirmations. These
      // receipts route text choices; only core can authorize, expire or consume an action.
      const controls = new Map<string, { receipt: ChatReceipt; expires: number }>()
      const acknowledgments = new Map<string, ChatReceipt>()
      const prune = () => {
        for (const [data, row] of controls) if (row.expires <= Date.now()) controls.delete(data)
      }
      const adapter: ExtensionChatAdapter = {
        async identify(operation) { const user = await identity(undefined, operation); return { id: user.id, username: user.username, discoveryUrl: `${base}/messages/@${encodeURIComponent(user.username)}` } },
        async inspect(id, operation) { const channel = await request<Channel>(`/channels/${rawId(id)}`, undefined, 'GET', undefined, operation); return { id: `${kind(channel)}:${channel.id}`, kind: kind(channel), eligible: !channel.delete_at } },
        async send(chatId, message, operation) {
          prune()
          const buttons = message.buttons?.flat() ?? []
          if (buttons.length > 10 || controls.size + buttons.length > 1000) throw new ExtensionChatError({ kind: 'blocked' })
          const choices = buttons.map(button => `${button.text}: \`cezar choose ${encodeURIComponent(button.data)}\``)
          const text = [message.text, ...(choices.length ? ['Send one of these commands in this chat:', ...choices] : [])].join('\n')
          const post = await request<Post>('/posts', { channel_id: rawId(chatId), message: text, ...(message.replyTo ? { root_id: rawId(message.replyTo.messageId) } : {}) }, 'POST', undefined, operation)
          const receipt = { chatId, messageId: post.id }
          for (const button of buttons) controls.set(button.data, { receipt, expires: Date.now() + 15 * 60_000 })
          return receipt
        },
        // Leave the text visible, just as copied native callbacks can outlive their UI.
        // Core rejects reuse and expiration; keeping receipts allows a useful rejection.
        async clearButtons(_receipt, _operation) {},
        async acknowledge(eventId, text, operation) {
          const receipt = acknowledgments.get(eventId)
          acknowledgments.delete(eventId)
          if (receipt) await request('/posts', { channel_id: rawId(receipt.chatId), root_id: receipt.messageId, message: text }, 'POST', undefined, operation)
        },
        async isMember(chatId, userId, operation) {
          try { await request(`/channels/${rawId(chatId)}/members/${rawId(userId)}`, undefined, 'GET', undefined, operation); return true } catch { return false }
        },
        async receiveSession(session) {
          while (!session.signal.aborted) {
            const { epoch, nextSequence } = await session.checkpoint()
            const rows = await receive(nextSequence === null ? null : nextSequence - 1, session)
            for (const row of rows) await session.accept({ kind: 'ordered', epoch, sequence: row.sequence, ...(row.event ? { event: row.event } : {}) })
            await session.health({ state: 'polling' })
            if (!rows.length) await idle(session.signal)
          }
        },
        async dispose() { abort.abort() },
      }
      async function receive(after: number | null, operation: ExtensionChatOperationContext) {
          const signal = AbortSignal.timeout(20_000)
          const self = await identity(signal, operation)
          prune()
          return receivePage({
            storage: context.storage, server: base, bot: self.id, started, after, channels: () => channels(signal, operation),
            page: (channel, page) => request(`/channels/${channel}/posts?page=${page}&per_page=100`, undefined, 'GET', signal, operation),
            normalize(post, channel) {
              if (post.user_id === self.id || post.delete_at || post.type) return
              const chat = { id: `${kind(channel)}:${channel.id}`, kind: kind(channel) }
              const user = { id: post.user_id, label: post.user_id }
              const addressed = chat.kind === 'private' || post.message.startsWith('cezar ') || post.message.includes(`@${self.username}`)
              const mention = `@${self.username} `
              const text = (post.message.startsWith(mention) ? post.message.slice(mention.length) : post.message).replace(/^cezar\s+/, '/')
              const choice = /^\/choose (\S+)$/.exec(text)
              let data: string | undefined
              try { if (choice) data = decodeURIComponent(choice[1]!) } catch {}
              const control = data === undefined ? undefined : controls.get(data)
              if (control && data !== undefined) {
                if (acknowledgments.size >= 100) acknowledgments.delete(acknowledgments.keys().next().value!)
                acknowledgments.set(post.id, { chatId: chat.id, messageId: post.root_id || post.id })
                return { id: post.id, kind: 'button', chat, user, data,
                  // Use the incoming chat, NEVER the stored chat, so copying a command
                  // into another conversation cannot borrow the original authorization.
                  receipt: { chatId: chat.id, messageId: control.receipt.messageId } }
              }
              return { id: post.id, kind: 'message', chat, user, messageId: post.id, at: post.create_at,
                text, addressed, ...(post.root_id ? { replyTo: { chatId: chat.id, messageId: post.root_id } } : {}) }
            },
          })
      }
      return adapter
    })
  },
})
