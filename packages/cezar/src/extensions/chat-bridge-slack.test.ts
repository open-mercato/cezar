import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionChatError } from '@open-mercato/cezar-extension-sdk/chat'
import { ChatExtensionBridge } from './chat-bridge.ts'
import type { ChatHealth, ReceiveJournal } from '../chat/connection.ts'
import type { ChatEvent } from '../chat/provider.ts'

afterEach(() => { vi.useRealTimers() })
// The adapter is its own package (outside this rootDir), so it is loaded untyped.
type SlackFactory = (credentials: Record<string, string>, request: unknown, options: object) => import('@open-mercato/cezar-extension-sdk/chat').ExtensionChatAdapter
const adapterPath = new URL('../../../chat-plugins/slack/src/adapter.ts', import.meta.url).pathname
const { createSlackAdapter } = await import(/* @vite-ignore */ adapterPath) as { createSlackAdapter: SlackFactory }

class Socket extends EventEmitter {
  readyState = 1
  send() {}
  ping() {}
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close') }
}
const message = (id: string, channel: string) => Buffer.from(JSON.stringify({ envelope_id: id, type: 'events_api', payload: { team_id: 'T1',
  authorizations: [{ user_id: 'U1', is_bot: true }], event: { type: 'message', channel, user: 'U2', ts: `${Math.floor(Date.now() / 1000)}.000001`, text: `<@U1> /task ${id}` } } }))

// The shipped Slack adapter, the host bridge and the host session services: one unresolvable event (missing_scope) must not end the bot.
it.each(['blocked', 'conflict'] as const)('a %s channel lookup drops one Slack event and the bot keeps receiving', async kind => {
  vi.useFakeTimers({ now: 1_800_000_000_000 })
  const sockets: Socket[] = [], reports: string[] = []
  const wire = async (method: string, body: Record<string, unknown>) => {
    if (method === 'auth.test') return { team_id: 'T1', user_id: 'U1' }
    if (method === 'apps.connections.open') return { url: 'wss://slack.com/socket' }
    if (method === 'conversations.info') {
      if (body.channel === 'CPOISON') throw new ExtensionChatError({ kind })
      return { channel: { id: body.channel, is_im: false, is_member: true } }
    }
    throw Error(method)
  }
  const adapter = createSlackAdapter({ appToken: 'xapp-1234567890', botToken: 'xoxb-1234567890' }, wire, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    socket: () => { const socket = new Socket(); sockets.push(socket); queueMicrotask(() => socket.emit('open')); return socket as never },
    report: (line: string) => { reports.push(line) },
  })
  const bridge = new ChatExtensionBridge(async (operation, _input, options) => {
    expect(operation).toBe('receiveSession')
    const service = (method: string, input?: unknown) => options.service!(method, input)
    return adapter.receiveSession!({ signal: options.signal!, assertActive: async () => options.signal!.throwIfAborted(),
      checkpoint: () => service('checkpoint') as never, accept: (delivery: unknown) => service('accept', delivery) as never,
      health: (value: unknown) => service('health', value) as never, openInteraction: () => { throw Error('unused') } })
  }, () => true, 'opaque')
  const epoch = randomUUID()
  const journal: ReceiveJournal = { recover: async () => {}, assertReady() {}, prepareReceive: async () => {}, snapshot: () => ({ epoch, nextOffset: null }),
    duplicate: () => false, finish: async () => {}, touch: async () => {}, flush: async () => {} }
  const accepted: string[] = [], health: ChatHealth['state'][] = []
  const connection = bridge.connect(journal, { accept: async (event: ChatEvent) => { accepted.push(event.chat.id) }, process: async () => {},
    needed: () => true, assertCredentials: async () => {}, onHealth: value => { health.push(value.state) } })
  try {
    connection.start()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0]!.emit('message', message('poison', 'CPOISON'))
    sockets[0]!.emit('message', message('good', 'CGOOD'))
    await vi.waitFor(() => expect(accepted).toEqual(['group:T1:U1:CGOOD']))
    expect(health).not.toContain('blocked')
    expect(health).not.toContain('conflict')
    expect(connection.health().state).not.toBe('blocked')
    expect(reports).toEqual([expect.stringMatching(/dropped an acknowledged event .*\(1 so far\)/)])
    expect(reports[0]).not.toMatch(/CPOISON|U2|T1/)
  } finally { await connection.stop(); await adapter.dispose?.() }
})
