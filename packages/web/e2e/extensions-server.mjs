import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'

const repo = resolve(import.meta.dirname, '../../..')
const root = mkdtempSync(join(tmpdir(), 'cezar-extension-browser-'))
for (const key of Object.keys(process.env)) if (key.startsWith('CEZ_')) delete process.env[key]
Object.assign(process.env, { CEZ_HOME: join(root, '.home'), CEZ_DRY_RUN: '1', CEZ_WEBHOOKS: '1', CEZ_CHAT_INBOUND: '1', CEZ_NO_BANNER: '1', CEZ_SKILLS_AUTO_UPDATE: '0', CEZ_AUTOMATIONS: '0', CEZ_TELEMETRY: '0' })
const run = (bin, args, cwd) => execFileSync(bin, args, { cwd, encoding: 'utf8', timeout: 90000 })
run('git', ['init', '-q'], root)
const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', root], join(repo, 'packages/extension-sdk')))
const tarball = join(root, packed[0].filename)
for (const name of ['project-summary', 'mattermost']) {
  const target = join(root, name)
  cpSync(join(repo, 'examples/extensions', name), target, { recursive: true, filter: path => !path.includes('/node_modules') && !path.includes('/dist') })
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  pkg.dependencies['@open-mercato/cezar-extension-sdk'] = tarball
  writeFileSync(join(target, 'package.json'), JSON.stringify(pkg))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false'], target)
  run(process.execPath, [join(target, 'node_modules/typescript/bin/tsc')], target)
}
// The Placements fixture (sidebar panel, palette command, task panel + command) is plain ESM
// with no dependencies, so it is copied as-is — nothing to install or compile.
const placementsRoot = join(root, 'placements-extension')
cpSync(resolve(import.meta.dirname, 'fixtures/placements-extension'), placementsRoot, { recursive: true })
// The wrapper records the real worker PID so the test can simulate an unexpected exit.
const summaryRoot = join(root, 'project-summary'), summaryPid = join(root, 'summary.pid')
const summaryManifest = JSON.parse(readFileSync(join(summaryRoot, 'cezar-extension.json'), 'utf8'))
summaryManifest.entry = 'bootstrap.mjs'
// The example declares task.create; the installed copy starts without it so /update-summary re-adds it.
summaryManifest.permissions = summaryManifest.permissions.filter(p => p !== 'task.create')
writeFileSync(join(summaryRoot, 'cezar-extension.json'), JSON.stringify(summaryManifest))
writeFileSync(join(summaryRoot, 'bootstrap.mjs'), `import {writeFileSync} from 'node:fs'; import extension from './dist/index.js'; export default { activate(context) { writeFileSync(${JSON.stringify(summaryPid)}, String(process.pid)); return extension.activate(context); } };`)
// Only the fixture entry replaces the network. The independently built example is unchanged.
const controlPort = Number(process.env.PORT) + 1
const chatRoot = join(root, 'mattermost')
const manifest = JSON.parse(readFileSync(join(chatRoot, 'cezar-extension.json'), 'utf8'))
manifest.entry = 'bootstrap.mjs'
writeFileSync(join(chatRoot, 'cezar-extension.json'), JSON.stringify(manifest))
writeFileSync(join(chatRoot, 'bootstrap.mjs'), `const fetchLocal=globalThis.fetch; globalThis.fetch=(url,init)=>{const path=new URL(url).pathname+new URL(url).search; return fetchLocal('http://127.0.0.1:${controlPort}'+path,init)}; export {default} from './dist/index.js';`)
const bot = 'b'.repeat(26), channel = 'c'.repeat(26), person = 'p'.repeat(26)
const sent = [], posts = []
let server, webhooks, store, project, failSend = false
const controls = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk
    const input = raw ? JSON.parse(raw) : {}
    const url = new URL(req.url, 'http://localhost')
    let output
    if (url.pathname.startsWith('/api/v4/')) {
      if (req.headers.authorization !== 'Bearer fixture-token') throw Error('Unexpected token')
      if (url.pathname === '/api/v4/users/me') output = { id: bot, username: 'fixturebot' }
      else if (url.pathname.includes('/members/')) output = { user_id: person }
      else if (url.pathname === `/api/v4/users/${bot}/channels`) output = [{ id: channel, type: 'D', delete_at: 0 }]
      else if (url.pathname.endsWith('/posts') && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? 0)
        const perPage = Number(url.searchParams.get('per_page') ?? 100)
        const rows = [...posts].sort((a, b) => b.create_at - a.create_at || b.id.localeCompare(a.id))
          .slice(page * perPage, (page + 1) * perPage)
        output = { order: rows.map(post => post.id), posts: Object.fromEntries(rows.map(post => [post.id, post])) }
      }
      else if (url.pathname === '/api/v4/posts') {
        if (failSend) { res.statusCode = 503; output = { error: 'fixture send failed' } }
        else { sent.push(input); output = { id: String(sent.length).padStart(26, 'a') } }
      } else output = { id: channel, type: 'D', delete_at: 0 }
    } else {
      if (req.method === 'POST' && url.pathname === '/message') posts.push({ id: String(posts.length + 1).padStart(26, 'x'), user_id: person, channel_id: channel, message: input.text, create_at: Date.now(), delete_at: 0, root_id: '', type: '' })
      if (req.method === 'POST' && url.pathname === '/restart') { await server.shutdownLifecycle(); server.closeAllConnections(); await webhooks.dispose(); await boot() }
      // Kill the summary worker and follow the host's own verdict through the API: `running` means
      // the RestartBudget absorbed the crash (kill again when exhausting), `failed` means it is spent.
      const summaryStatus = async () => {
        const listed = await fetch(`http://127.0.0.1:${process.env.PORT}/api/v1/p/${project.id}/extensions/access`, { headers: { Host: `127.0.0.1:${process.env.PORT}` } })
        return (await listed.json()).extensions.find(item => item.manifest.id === 'open-mercato.project-summary')?.status
      }
      const crashSummary = async until => {
        for (let kills = 0; kills < 8; kills++) {
          process.kill(Number(readFileSync(summaryPid, 'utf8')), 'SIGKILL')
          const deadline = Date.now() + 20_000
          let status
          do { await new Promise(r => setTimeout(r, 100)); status = await summaryStatus() } while (Date.now() < deadline && status !== 'running' && status !== 'failed')
          if (status !== 'running' && status !== 'failed') throw new Error(`summary worker stuck in ${status}`)
          if (status === until) return
          if (status === 'failed') throw new Error('summary worker failed before the budget was expected to run out')
        }
        throw new Error('summary worker never exhausted its restart budget')
      }
      if (req.method === 'POST' && url.pathname === '/crash-summary') await crashSummary('running')
      if (req.method === 'POST' && url.pathname === '/exhaust-summary') await crashSummary('failed')
      if (req.method === 'POST' && url.pathname === '/update-summary') { summaryManifest.version = '1.1.0'; summaryManifest.permissions.push('task.create'); writeFileSync(join(summaryRoot, 'cezar-extension.json'), JSON.stringify(summaryManifest)) }
      if (req.method === 'POST' && url.pathname === '/fail-send') failSend = input.value
      const service = await webhooks.get(project.id, root, true)
      output = { summary: join(root, 'project-summary'), chat: chatRoot, placements: placementsRoot, projectId: project.id, sent, inbound: service.chats.get('open-mercato.mattermost/chat')?.list(), runs: store.listRuns() }
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(output))
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) }
})
await new Promise(resolve => controls.listen(controlPort, '127.0.0.1', resolve))
const [{ WebhookCoordinator }, { RunStore }, { RunManager }, { startServer }, { registerProject }] = await Promise.all([
  import('../../cezar/src/webhooks/coordinator.ts'), import('../../cezar/src/runs/store.ts'), import('../../cezar/src/workflows/run.ts'), import('../../cezar/src/server/server.ts'), import('../../cezar/src/workspace/projects.ts'),
])
project = await registerProject(root)
async function boot() {
  store = RunStore.open(join(root, '.ai/cezar'))
  const manager = new RunManager(store, root)
  webhooks = new WebhookCoordinator({ mode: () => 'local', ports: () => [], projects: async () => [{ ...project, status: 'ready' }], dryRun: false })
  await webhooks.get(project.id, root, true)
  server = startServer({ repoRoot: root, bootProjectId: project.id, store, manager, webhooks, version: 'fixture' }, Number(process.env.PORT))
  if (!server.listening) await once(server, 'listening')
}
await boot()
let closing = false
async function close() {
  if (closing) return; closing = true
  controls.close(); await server.shutdownLifecycle(); server.closeAllConnections(); await webhooks.dispose()
  rmSync(root, { recursive: true, force: true }); process.exit(0)
}
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close())
