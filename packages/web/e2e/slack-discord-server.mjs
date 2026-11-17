import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chatControlFile } from './chat-control.ts'
if (!process.env.LD_PRELOAD?.includes('netguard')) throw new Error('Run the browser fixture under the loopback netguard')
import { fakeChatTransport } from '../../cezar/src/chat/test-support/chat-transport.testkit.ts'
const provider = process.env.FIXTURE_PROVIDER
// A previous run on this port must not hand the test a stale control port.
rmSync(chatControlFile(process.env.PORT), { force: true })
if (!['slack', 'discord'].includes(provider)) throw new Error('Choose a simulated provider')
const root = mkdtempSync(join(tmpdir(), 'cezar-' + provider + '-browser-'))
// CEZ_HOME outside the checkout, as in real use: inside it, agent scratch falls back to the platform /tmp.
const home = mkdtempSync(join(tmpdir(), 'cezar-' + provider + '-home-'))
for (const key of Object.keys(process.env)) if (key.startsWith('CEZ_')) delete process.env[key]
Object.assign(process.env, { CEZ_HOME: home, CEZ_DRY_RUN: '1', CEZ_WEBHOOKS: '1', CEZ_CHAT_INBOUND: '1', CEZ_NO_BANNER: '1', CEZ_SKILLS_AUTO_UPDATE: '0', CEZ_AUTOMATIONS: '0', CEZ_TELEMETRY: '0' })
execFileSync('git', ['init', '-q'], { cwd: root, timeout: 5000 })
const [{ WebhookCoordinator }, { RunStore }, { RunManager }, { startServer }, { registerProject }] = await Promise.all([
 import('../../cezar/src/webhooks/coordinator.ts'), import('../../cezar/src/runs/store.ts'), import('../../cezar/src/workflows/run.ts'), import('../../cezar/src/server/server.ts'), import('../../cezar/src/workspace/projects.ts'),
])
const project = await registerProject(root)
let server, webhooks, store, seedId, calls = 0, failSend = false, sequence = 100
// The wire belongs to the shipped adapters and their packed tests; this drives the cockpit through the generic seam.
const slack = provider === 'slack', sent = []
const ids = slack ? { bot: 'T1:U1', user: 'U2', privateChat: 'private:T1:U1:D1', groupChat: 'group:T1:U1:C1' }
 : { bot: '100000000000000001', user: '100000000000000002', privateChat: 'discord:dm:100000000000000003', groupChat: 'discord:guild:100000000000000005:100000000000000004' }
const nextId = () => slack ? `1700000000.${String(++sequence).padStart(6, '0')}` : String(100000000000000000n + BigInt(++sequence))
const fake = fakeChatTransport({ botId: ids.bot, isGroup: id => id === ids.groupChat, identify: async () => { calls++ },
 send(chatId, message) {
  calls++; if (failSend) throw new Error('Simulated delivery failure')
  const row = { chatId, messageId: nextId(), text: message.text, buttons: message.buttons, [slack ? 'channel' : 'channel_id']: chatId.split(':').at(-1) }
  sent.push(row); return { chatId, messageId: row.messageId }
 } })
const chatOf = group => ({ id: group ? ids.groupChat : ids.privateChat, kind: group ? 'group' : 'private' })
const person = { id: ids.user, label: 'FixturePerson' }
const accept = event => { const connection = fake.connections.at(-1); if (!connection) throw new Error('Bot not connected'); connection.accept(event).catch(error => console.error(error)) }
function message(raw, group = false, reply) {
 const addressed = !group || /^(@bot|<@\w+>)\s/.test(raw), bare = raw.replace(/^(@bot|<@\w+>)\s+/, ''), text = slack ? bare.replace(/^cezar\s+/i, '/') : bare
 const id = `event-${++sequence}`, at = Date.now(), start = /^\/start\s+(\S+)$/.exec(text)
 accept(start && addressed ? { kind: 'start', id, code: start[1], at, chat: chatOf(group), user: person }
  : { kind: 'message', id, messageId: nextId(), at, chat: chatOf(group), user: person, text, addressed, ...(reply ? { replyTo: { chatId: reply.chatId, messageId: reply.messageId } } : {}) })
}
async function boot(seed = false) {
 store = RunStore.open(join(root, '.ai/cezar'))
 const manager = new RunManager(store, root)
 webhooks = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [{ ...project, status: 'ready' }], // Exercise actual bot delivery; only the agent runner uses CEZ_DRY_RUN.
  dryRun: false,
  chatTransport: () => fake.transport,
 })
 const service = await webhooks.get(project.id, root, true)
 if (seed) {
  const { receiver } = await service.create({ name: 'Existing webhook', format: provider + '.v1', url: provider === 'slack' ? 'https://hooks.slack.com/services/T1/B1/fixture' : 'https://discord.com/api/webhooks/100000000000000001/' + 'x'.repeat(68), profile: 'standard', graceSeconds: 0 })
  seedId = receiver.id
 }
 server = startServer({ repoRoot: root, bootProjectId: project.id, store, manager, webhooks, version: 'fixture' }, Number(process.env.PORT))
 // /restart answers only once the new server accepts connections, or the spec's reload races it.
 if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
}
await boot(true)
const controls = createServer(async (req, res) => {
 try {
  let raw = ''; for await (const chunk of req) raw += chunk
  const input = raw ? JSON.parse(raw) : {}
  if (req.method === 'POST') {
   if (req.url === '/reply') {
    const receipt = sent.find(m => m.chatId === ids.groupChat && m.text.includes(input.runId))
    if (!receipt) throw new Error('No correlated group receipt')
    message(input.text, true, receipt)
   }
   if (req.url === '/message') message(input.text, input.group)
   if (req.url === '/confirm') {
    const preview = sent.find(m => m.text.startsWith('Start a new task?'))
    if (!preview) throw new Error('No preview')
    accept({ kind: 'button', id: `event-${++sequence}`, chat: chatOf(preview.chatId === ids.groupChat), user: person, receipt: { chatId: preview.chatId, messageId: preview.messageId }, data: preview.buttons.flat().find(b => b.text === 'Confirm').data })
   }
   if (req.url === '/fail-send') failSend = input.value
   if (req.url === '/restart') { await server.shutdownLifecycle(); await webhooks.dispose(); server.closeAllConnections(); await boot() }
   if (req.url === '/finish') { const run = store.listRuns().find(r => r.task.includes('deterministic fixture')); if (!run) throw new Error('No task'); store.updateRun(run.id, { status: 'done', completionReason: 'completed', finishedAt: new Date().toISOString() }) }
  }
  res.setHeader('Content-Type', 'application/json')
  const service = (await webhooks.get(project.id, root, true))[provider]
  const snapshot = JSON.stringify({ provider, runs: store.listRuns(), events: store.listRuns().flatMap(run => store.readEvents(run.id).map(event => ({ ...event, runId: run.id }))), states: [...service.bots.values()].map(bot => bot.state.snapshot()), pairings: [...service.pairings.sessions.values()], seedId, calls, sent, inbound: (await webhooks.get(project.id, root, true))[provider].list() })
  // Local synthetic evidence only. Never use this harness with platform credentials.
  writeFileSync(join(tmpdir(), provider + '-browser-' + process.env.PORT + '.json'), snapshot)
  res.end(snapshot)
 } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) }
})
// The runner reserves only the app port; the control channel takes any free port and publishes it.
controls.listen(0, '127.0.0.1', () => {
 const file = chatControlFile(process.env.PORT)
 mkdirSync(dirname(file), { recursive: true })
 writeFileSync(file, JSON.stringify({ port: controls.address().port }))
})
let closing = false
async function close() {
 if (closing) return; closing = true
 controls.close()
 await server.shutdownLifecycle(); server.closeAllConnections(); await webhooks.dispose()
 for (const dir of [root, home]) rmSync(dir, { recursive: true, force: true }); process.exit(0)
}
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close())
