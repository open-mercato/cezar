// Renders every notch state from the real page in WebKit, on a painted menu bar, into
// `.ai/specs/assets/notch/` (`node packages/desktop/scripts/notch-snapshots.mjs`). This is the page
// and not the panel: the screen itself needs Screen Recording permission to capture.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ui = path.resolve(here, '../ui')
const output = path.resolve(here, '../../../.ai/specs/assets/notch')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }

const entry = (id, name, avatar, face, text, badge) => ({ id, name, avatar, face, text, ...(badge ? { badge } : {}) })
const mini = ({ id, name, avatar, face }) => ({ id, name, avatar, face })
const model = (...active) => ({ primary: active[0], minis: active.slice(1, 5).map(mini), overflow: Math.max(0, active.length - 5), active })

const watcher = entry('watcher', 'Repo watcher', 0, 'working', 'Reviewing PR #1880 for conflicts')
const release = entry('release', 'Release desk', 19, 'needs-you', 'Ready to merge #1874', '1 approval')
const triage = entry('triage', 'Triage', 3, 'working', 'Reading 4 new issues')
const nightly = entry('nightly', 'Nightly', 6, 'error', 'Something went wrong')
const docs = entry('docs', 'Docs', 7, 'working', 'Updating the guide')
const costs = entry('costs', 'Costs', 2, 'working', 'Summing the week')
const extra = entry('extra', 'Dependencies', 5, 'working', 'Checking updates')

const notched = { width: 200, height: 37, top: 0, centre: 500 }
const floating = { width: 0, height: 32, top: 31, centre: 500 }

const states = [
  { name: '1-working', housing: notched, model: model(watcher) },
  { name: '2-needs-you', housing: notched, model: model(release) },
  { name: '3-error', housing: notched, model: model(nightly) },
  { name: '4-two-managers', housing: notched, model: model(release, watcher) },
  { name: '5-more-than-four', housing: notched, model: model(release, nightly, watcher, triage, docs, costs, extra) },
  { name: '6-expanded', housing: notched, model: model(release, nightly, watcher, triage), expanded: true },
  { name: '7-no-notch', housing: floating, model: model(release, watcher) },
  { name: '8-no-notch-expanded', housing: floating, model: model(release, watcher), expanded: true },
  { name: '9-faces', housing: notched, model: { ...model(release), active: [release, nightly, watcher, entry('idle', 'Idle (only while folding away)', 4, 'idle', 'Nothing to do')] }, expanded: true },
]

const server = createServer((request, response) => {
  const file = path.join(ui, new URL(request.url, 'http://x').pathname)
  if (!file.startsWith(ui)) return response.writeHead(403).end()
  try {
    response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'text/plain' }).end(readFileSync(file))
  } catch {
    response.writeHead(404).end()
  }
})

server.listen(0, '127.0.0.1', () => {
  mkdirSync(output, { recursive: true })
  const { port } = server.address()
  const layout = JSON.parse(readFileSync(path.join(ui, 'notch/layout.json'), 'utf8'))
  // Compiled: under the `swift` interpreter WebKit never finishes loading.
  const binary = path.join(mkdtempSync(path.join(tmpdir(), 'notch-')), 'snapshots')
  const compiled = spawnSync('swiftc', [path.join(here, 'notch-snapshots.swift'), '-o', binary], { stdio: 'inherit' })
  if (compiled.status !== 0) process.exit(1)
  // Not spawnSync: this process is the page's server.
  const run = spawn(binary, [String(port), output, JSON.stringify({ layout, states })], { stdio: 'inherit', timeout: 60_000 })
  run.on('exit', (code) => process.exit(code ?? 1))
})
