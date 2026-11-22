import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { bootProjectId, cezarCli, fixtureServeEnv, getJson, stopFixtureServer } from '../agent-browser'

/**
 * A dry-run cezar seeded with the strings that blew the phone layout wide (the approvals bug):
 * unbroken task ids, SHAs, URLs and long titles, on runs, a merge card's reason, a question card
 * and a job card. `phone-overflow.e2e.ts` sweeps the pages over it; the same boot backs a manual
 * check (`npx tsx packages/web/e2e/fixtures/phone-overflow-seed.ts`).
 */

/** No spaces anywhere: only `overflow-wrap: anywhere` can break it. */
export const UNBROKEN = 'cezar/5aeb1ea2-2d51-4e8f-a558-4d0e90c1b7a4f9d2e6c8b0a1d3f5e7c9b2a4d6f8e0c1b3a5d7f9'
const LONG_URL = 'https://github.com/open-mercato/cezar/pull/2361/files#diff-5aeb1ea22d514e8fa5584d0e90c1b7a4f9d2e6c8b0a1d3f5e7c9b2a4d6f8e0c1'
const LONG_TITLE = `fix(mobile): app-icon badge can reach 0 and clears handled notifications ${UNBROKEN}`
const SHA = '1ad4eb8b5dce0f3a9b7c6d5e4f3a2b1c0d9e8f7a'

export interface OverflowFixture {
  baseUrl: string
  projectId: string
  managerId: string
  runIds: string[]
  stop: () => Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      if (await check()) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`cezar e2e: ${what} never happened`)
}

const post = async (url: string, body: unknown) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`cezar e2e: POST ${url} answered ${res.status}: ${await res.text()}`)
  return (await res.json()) as Record<string, unknown>
}

function boot(dataRoot: string, port: number): ChildProcess {
  return spawn(process.execPath, [cezarCli, 'serve', '--repo', dataRoot, '--port', String(port), '--no-open'], {
    env: fixtureServeEnv(dataRoot),
    stdio: 'ignore',
  })
}

export async function bootOverflowFixture(): Promise<OverflowFixture> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'cezar-e2e-overflow-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dataRoot, ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'e2e@cezar.test')
  git('config', 'user.name', 'cezar e2e')
  writeFileSync(join(dataRoot, 'README.md'), '# phone overflow fixture repo\n', 'utf8')
  git('add', '.')
  git('commit', '-qm', 'init')

  const port = await freePort()
  const baseUrl = `http://localhost:${port}`
  let server = boot(dataRoot, port)
  const healthy = () => waitFor(async () => (await fetch(`${baseUrl}/api/v1/health`)).ok, 'the fixture server answering')
  await healthy()
  const projectId = await bootProjectId(baseUrl)

  // Two settled dry runs, titled with an unbroken token.
  const runIds: string[] = []
  for (const task of [LONG_TITLE, `Review ${LONG_URL} until the merge queue settles ${UNBROKEN}`]) {
    const created = await post(`${baseUrl}/api/v1/runs`, { task, workflow: 'quick-task' })
    runIds.push(created.id as string)
  }
  for (const id of runIds) {
    await waitFor(async () => ['waiting', 'review', 'done', 'failed'].includes((await getJson<{ status: string }>(`${baseUrl}/api/v1/runs/${id}`)).status), `run ${id} settling`)
    await fetch(`${baseUrl}/api/v1/runs/${id}/finish`, { method: 'POST' })
    await waitFor(async () => ['review', 'done', 'failed'].includes((await getJson<{ status: string }>(`${baseUrl}/api/v1/runs/${id}`)).status), `run ${id} finishing`)
  }

  const manager = await post(`${baseUrl}/api/v1/workspace/managers`, {
    name: `Mobile app creator ${UNBROKEN}`.slice(0, 80),
    instructions: `Watch ${UNBROKEN}`,
    projects: 'all',
    cronMinutes: 0,
  })
  const managerId = manager.id as string
  await waitFor(async () => {
    const { managers } = await getJson<{ managers: Array<{ id: string; status: string }> }>(`${baseUrl}/api/v1/workspace/managers`)
    return managers.find((entry) => entry.id === managerId)?.status === 'idle'
  }, 'the manager idling')

  // The runs carry a PR, so merge cards list them as chips: edited at rest, then rebooted.
  await stopFixtureServer(server, undefined)
  const runsPath = join(dataRoot, '.ai/cezar/runs.json')
  const stored = JSON.parse(readFileSync(runsPath, 'utf8')) as { runs?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
  const rows = Array.isArray(stored) ? stored : stored.runs ?? []
  for (const row of rows) if (runIds.includes(row.id as string)) row.pullRequestUrl = 'https://github.com/open-mercato/cezar/pull/2361'
  writeFileSync(runsPath, JSON.stringify(stored), 'utf8')

  const chat = resolve(dataRoot, '.cez-home/managers', managerId, 'chat.ndjson')
  // A manager with no cadence has not spoken yet: its chat starts here.
  mkdirSync(dirname(chat), { recursive: true })
  const seqs = (existsSync(chat) ? readFileSync(chat, 'utf8') : '').split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { seq: number }).seq)
  let seq = Math.max(0, ...seqs)
  const at = new Date().toISOString()
  const source = { projectId, runId: runIds[0]! }
  const messages = [
    { kind: 'user', text: `Approve view page in phone view is too wide ${UNBROKEN}` },
    {
      kind: 'assistant', turn: 'chat', streaming: false, commands: [],
      text: `Started [[task:${projectId}/${runIds[0]}]] for ${UNBROKEN}. See ${LONG_URL} and \`${SHA}${SHA}\`.\n\n\`\`\`\n${UNBROKEN}${UNBROKEN}\n\`\`\``,
    },
    {
      kind: 'assistant', turn: 'chat', streaming: false, commands: [],
      text: `Which branch should ${UNBROKEN} land on?`,
      ask: { id: 'branch', questions: [{ header: 'Branch', question: `Merge ${UNBROKEN} into which branch?`, options: [{ label: 'main', description: UNBROKEN }, { label: `release/${UNBROKEN}`.slice(0, 60), description: LONG_URL }] }] },
    },
    {
      kind: 'action', status: 'pending', sourceTasks: [source],
      action: { type: 'merge-pr', projectId, number: 2361, title: LONG_TITLE, method: 'squash', headSha: SHA },
      reason: `Badge fix from task ${UNBROKEN}: all review minors fixed in ${SHA}, merged with main, 16 checks green`,
    },
    {
      kind: 'action', status: 'pending',
      action: { type: 'add-job', name: UNBROKEN.slice(0, 80), prompt: `Every morning summarise ${LONG_URL} ${UNBROKEN}`, everyMinutes: 60 },
      reason: `Keeps ${UNBROKEN} watched`,
    },
  ]
  for (const message of messages) {
    seq += 1
    appendFileSync(chat, `${JSON.stringify({ id: `overflow-${seq}`, seq, at, ...message })}\n`, 'utf8')
  }

  server = boot(dataRoot, port)
  await healthy()
  // A memory entry with the longest key the schema allows and an unbroken token in its text.
  const key = `branch-${UNBROKEN.replace(/[^a-z0-9]/g, '-')}`.slice(0, 64)
  const memory = await fetch(`${baseUrl}/api/v1/workspace/managers/${managerId}/memory/${key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'decision', text: `Merge ${UNBROKEN} into main`, why: LONG_URL.slice(0, 200), source: 'user' }),
  })
  if (!memory.ok) throw new Error(`cezar e2e: seeding memory answered ${memory.status}: ${await memory.text()}`)
  return { baseUrl, projectId, managerId, runIds, stop: () => stopFixtureServer(server, dataRoot) }
}

// A manual check: boot it and leave it up until Ctrl-C.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const fixture = await bootOverflowFixture()
  console.log(JSON.stringify({ ...fixture, stop: undefined }))
  const stop = () => void fixture.stop().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
