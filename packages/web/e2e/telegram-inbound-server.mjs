import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const root = mkdtempSync(join(tmpdir(), 'cezar-telegram-inbound-e2e-'))
for (const key of Object.keys(process.env)) if (key.startsWith('CEZ_')) delete process.env[key]
Object.assign(process.env, { CEZ_HOME: join(root, '.home'), CEZ_DRY_RUN: '1', CEZ_WEBHOOKS: '1', CEZ_CHAT_INBOUND: '1', CEZ_NO_BANNER: '1', CEZ_SKILLS_AUTO_UPDATE: '0', CEZ_AUTOMATIONS: '0', CEZ_TELEMETRY: '0' })
execFileSync('git', ['init', '-q'], { cwd: root })
const [{ WebhookCoordinator }, { RunStore }, { RunManager }, { startServer }, { registerProject }] = await Promise.all([
  import('../../cezar/src/webhooks/coordinator.ts'), import('../../cezar/src/runs/store.ts'), import('../../cezar/src/workflows/run.ts'), import('../../cezar/src/server/server.ts'), import('../../cezar/src/workspace/projects.ts'),
])
const project = await registerProject(root), store = RunStore.open(join(root, '.ai/cezar')), manager = new RunManager(store, root)
let wake, sequence = 1
const updates = []
const fixtureLog = join(root, 'telegram-inbound-fixture.json')
const sent = []
const writeFixtureLog = (extra = {}) => writeFileSync(fixtureLog, JSON.stringify({ sent, ...extra }, null, 2))
writeFixtureLog()
const fakeCall = async (method, body, signal) => {
  if (method === 'getMe') return { id: 123456, username: 'fixture_bot', first_name: 'Fixture bot' }
  if (method === 'getChat') return { id: Number(body.chat_id), type: 'supergroup', is_forum: false }
  if (method === 'getUpdates') {
    if (!updates.length) await new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, 500)
      wake = done
      signal?.addEventListener('abort', done, { once: true })
    })
    return updates.splice(0)
  }
  if (method === 'getChatMember') return { user: { id: Number(body.user_id) }, status: Number(body.user_id) === 123456 ? 'administrator' : 'member' }
  if (method === 'sendMessage') {
    const message = { message_id: ++sequence, chat: { id: Number(body.chat_id) }, text: body.text, ...(body.reply_markup ? { reply_markup: body.reply_markup } : {}) }
    sent.push(message); writeFixtureLog()
    // The person taps Confirm on the /task preview, as Telegram would deliver it: a callback on that message.
    if (String(body.text).startsWith('Start a new task?')) {
      const confirm = body.reply_markup.inline_keyboard[0].find(button => button.text === 'Confirm')
      updates.push({ update_id: ++sequence, callback_query: { id: `tap-${sequence}`, data: confirm.callback_data, from: { id: 456, is_bot: false, first_name: 'Fixture person' }, message: { message_id: message.message_id, chat: { id: 456, type: 'private' } } } })
      writeFixtureLog({ taskConfirmed: true }); setTimeout(() => wake?.(), 0)
    }
    return message
  }
  return true
}
const webhooks = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [{ ...project, status: 'ready' }], dryRun: true, telegramCall: () => fakeCall })
const service = await webhooks.get(project.id, root, true)
// Token-led setup uses the TelegramInbound token client. Point that private
// test seam at the same simulator for every lazily resolved service instance.
// A setup named like "Group …" is answered from a group, as Telegram does after ?startgroup=.
let groupSetup = false
const patchTokenCall = current => {
  current.telegram.deps.callToken = () => fakeCall
  if (current.telegram.beginSetup.fixturePatched) return
  const beginSetup = current.telegram.beginSetup.bind(current.telegram)
  current.telegram.beginSetup = Object.assign(async raw => { groupSetup = /^group/i.test(String(raw?.name ?? '')); return beginSetup(raw) }, { fixturePatched: true })
}
patchTokenCall(service)
const getService = webhooks.get.bind(webhooks)
webhooks.get = async (...args) => { const current = await getService(...args); patchTokenCall(current); return current }
// The private chat is set up in the browser through the token-led wizard; only an unbound group receiver is seeded (unused by the current specs).
const confirmPairing = service.telegram.confirm.bind(service.telegram)
service.telegram.confirm = async (...args) => {
  const result = await confirmPairing(...args)
  if (String(args[1]?.candidateUserId) === '456') {
    const from = { id: 456, is_bot: false, first_name: 'Fixture person' }, date = Math.ceil(Date.now() / 1000)
    // Bare text only earns the help message; /task previews, and the Confirm tap above starts the task.
    updates.push({ update_id: ++sequence, message: { message_id: sequence, date, chat: { id: 456, type: 'private' }, from, text: 'Bare text must never start a fixture task.', entities: [] } })
    const command = '/task Please finish the deterministic Telegram fixture task.'
    updates.push({ update_id: ++sequence, message: { message_id: sequence, date, chat: { id: 456, type: 'private' }, from, text: command, entities: [{ type: 'bot_command', offset: 0, length: 5 }] } })
    writeFixtureLog({ taskSubmitted: true }); wake?.()
    // The task exists only after the Confirm tap, so wait for it before completing it.
    const finish = setInterval(() => {
      const run = store.listRuns().find(row => row.task.includes('deterministic Telegram fixture'))
      if (!run) return
      clearInterval(finish)
      setTimeout(() => { if (store.getRun(run.id)?.status !== 'done') store.updateRun(run.id, { status: 'done', completionReason: 'fixture completed' }) }, 750)
    }, 100)
    finish.unref()
  }
  return result
}
const { receiver: groupReceiver } = await service.create({ name: 'Telegram group fixture', format: 'telegram.v1', url: `https://api.telegram.org/bot123456:${'x'.repeat(35)}/sendMessage`, telegramChatId: '-12345', profile: 'standard', graceSeconds: 0 })
await service.test(groupReceiver.id, { expectedRevision: groupReceiver.revision, deliveryRevision: groupReceiver.deliveryRevision, operationId: 'group-fixture-test' })
await service.tick()
await service.activate(groupReceiver.id, service.list().receivers.find(row => row.id === groupReceiver.id).revision)
// Simulation is fixture-local: pairing creates a Telegram update, never a real network request.
const create = service.telegram.pairings.create.bind(service.telegram.pairings)
service.telegram.pairings.create = (...args) => {
  const result = create(...args), code = new URL(result.deepLink).searchParams.get('start')
  if (groupSetup && args[0]?.chatId === 'pending') {
    const command = '/start@fixture_bot'
    updates.push({ update_id: ++sequence, message: { message_id: sequence, date: Math.ceil(Date.now() / 1000), chat: { id: -777, type: 'supergroup', title: 'Fixture team' }, from: { id: 789, is_bot: false, first_name: 'Group person' }, text: `${command} ${code}`, entities: [{ type: 'bot_command', offset: 0, length: command.length }] } })
    wake?.(); return result
  }
  updates.push({ update_id: ++sequence, message: { message_id: sequence, date: Math.ceil(Date.now() / 1000), chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false, first_name: 'Fixture person' }, text: `/start ${code}`, entities: [{ type: 'bot_command', offset: 0, length: 6 }] } })
  wake?.(); return result
}
// The normal server wiring supplies the production Telegram task seam. Once the
// private grant is activated, inject one deterministic task update. Dry-run's
// provider/runner path completes it locally; no Telegram credential or network
// request is involved.
const server = startServer({ repoRoot: root, bootProjectId: project.id, store, manager, webhooks, version: 'test' }, Number(process.env.PORT))
let closing = false
async function close() {
  if (closing) return; closing = true
  await server.shutdownLifecycle(); await webhooks.dispose(); store.flush()
  rmSync(root, { recursive: true, force: true }); process.exit(0)
}
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close())
