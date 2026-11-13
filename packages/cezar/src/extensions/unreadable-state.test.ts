import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatSelectionStore } from './chat-selection-store.ts'
import { shippedRecord } from './consent.ts'
import { loadChatDeliveryCatalog } from './delivery-catalog.ts'
import { artifactIntegrity } from './installer.ts'
import { ExtensionManager } from './manager.ts'
import { chatManagementOwner } from './project-runtime.ts'
import { closeProjectExtensions, extensionRoutes } from '../server/extensions.ts'
import type { ProjectContext } from '../server/project-context.ts'

// Unreadable stored state fails closed for its own record only, and is reported.
const spawns = vi.hoisted(() => vi.fn())
vi.mock('./worker-process.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./worker-process.ts')>()
  return { ...actual, spawnWorkerProcess: (options: Parameters<typeof actual.spawnWorkerProcess>[0]) => { spawns(); return actual.spawnWorkerProcess(options) } }
})

const roots: string[] = []
const managers: ExtensionManager[] = []
const previousHome = process.env.CEZ_HOME
beforeEach(() => { spawns.mockClear() })
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  process.env.CEZ_HOME = previousHome
})

async function shippedCatalog(directory: string) {
  const stamps = []
  for (const provider of ['telegram', 'slack', 'discord']) {
    const artifact = join(directory, provider)
    await mkdir(join(artifact, 'dist'), { recursive: true })
    const manifest = JSON.parse(await readFile(new URL(`../../../chat-plugins/${provider}/cezar-extension.json`, import.meta.url), 'utf8')) as { id: string; version: string }
    await writeFile(join(artifact, 'cezar-extension.json'), JSON.stringify(manifest))
    await writeFile(join(artifact, 'package.json'), JSON.stringify({ name: `@open-mercato/cezar-chat-${provider}`, version: manifest.version, type: 'module' }))
    await writeFile(join(artifact, 'dist', 'index.js'), `export default { activate(context) { context.chat.register('${provider}', () => ({})) } }`)
    stamps.push({ provider, extensionId: manifest.id, version: manifest.version, integrity: await artifactIntegrity(artifact) })
  }
  await writeFile(join(directory, 'catalog.json'), JSON.stringify(stamps))
}

/** modern.tool and chat.fixture installed and approved, chat.fixture selected for Telegram, shipped Discord enabled. */
async function state() {
  const root = await mkdtemp(join(tmpdir(), 'cezar-unreadable-')); roots.push(root)
  // Enabling a shipped adapter opens the webhook owner, which requires ignored private state.
  execFileSync('git', ['init', '-q'], { cwd: root, timeout: 5000 })
  await writeFile(join(root, '.gitignore'), '.ai/\nhome/\n')
  const data = join(root, '.ai', 'cezar'), home = join(root, 'home'), shipped = join(root, 'package')
  await mkdir(join(shipped, 'dist', 'chat-plugins'), { recursive: true })
  await shippedCatalog(join(shipped, 'dist', 'chat-plugins'))
  const logs: string[] = []
  const open = () => {
    const manager = new ExtensionManager(data, 'project', root, { home, deliveryPackageRoot: shipped, chatOnDemand: true, openChatOwner: chatManagementOwner({ root, dataDir: data, projectId: 'project' }), log: (_level, message) => { logs.push(message) } })
    managers.push(manager)
    return manager
  }
  const tool = join(root, 'tool'), chat = join(root, 'chat')
  await mkdir(tool); await mkdir(chat)
  await writeFile(join(tool, 'cezar-extension.json'), JSON.stringify({ id: 'modern.tool', name: 'Modern', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', capabilities: ['commands'], permissions: [], contributes: { commands: [{ id: 'a', label: 'Do' }] } }))
  await writeFile(join(tool, 'index.mjs'), `export default { activate(c) { c.commands.register('a', () => ({ message: 'ok' })) } }`)
  const chatManifest = JSON.parse(await readFile(new URL('../../../chat-plugins/telegram/cezar-extension.json', import.meta.url), 'utf8')) as Record<string, unknown>
  await writeFile(join(chat, 'cezar-extension.json'), JSON.stringify({ ...chatManifest, id: 'chat.fixture', entry: 'index.mjs' }))
  await writeFile(join(chat, 'index.mjs'), `export function activate(c) { c.chat.register('telegram', () => ({})) }`)
  const setup = open()
  const records = [await setup.install(tool), await setup.install(chat)]
  const [discord] = await loadChatDeliveryCatalog(shipped, 'discord')
  await setup.approvals.replace([...records.map(record => ({ ...record, enabled: true })), shippedRecord(discord!, true)])
  await new ChatSelectionStore(data, home).replace('telegram', null, { kind: 'installed', record: records[1]!, localProviderId: 'telegram' })
  await setup.close()
  return { root, data, home, logs, open, approvals: join(data, 'extensions', 'registry.json'), catalog: join(home, 'extensions', 'registry.json'), selection: join(data, 'extensions', 'chat-selections', 'telegram.json') }
}
const item = async (manager: ExtensionManager, id: string) => (await manager.inventory()).find(entry => entry.record.manifest.id === id)
const edit = async (file: string, change: (rows: Record<string, unknown>[]) => unknown) =>
  writeFile(file, JSON.stringify(change(JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>[])))
const breakManifest = (row: Record<string, unknown>) => ({ ...row, manifest: { ...(row.manifest as object), apiVersion: '9.9' } })
const idOf = (row: Record<string, unknown>) => (row.manifest as { id: string }).id

async function routes(fixture: Awaited<ReturnType<typeof state>>) {
  process.env.CEZ_HOME = fixture.home
  const project = { id: 'project', root: fixture.root, dataDir: fixture.data, store: { listRuns: () => [], getRun: () => undefined, on() {}, off() {} } } as unknown as ProjectContext
  const app = new Hono<{ Variables: { project: ProjectContext } }>().use(async (c, next) => { c.set('project', project); await next() }).route('/', extensionRoutes())
  return { app, close: () => closeProjectExtensions(project) }
}

it('confines an unreadable chat selection to its own provider', async () => {
  const fixture = await state()
  await writeFile(fixture.selection, '{')
  const { app, close } = await routes(fixture)
  try {
    expect((await app.request('/extensions/access')).status).toBe(200)
    const inventory = await app.request('/extensions/inventory')
    expect(inventory.status).toBe(200)
    const { extensions } = await inventory.json() as { extensions: { availability: string; record: { manifest: { id: string }; enabled: boolean } }[] }
    expect(extensions.find(entry => entry.record.manifest.id === 'modern.tool')).toMatchObject({ availability: 'available', record: { enabled: true } })
  } finally { await close() }
  const manager = fixture.open()
  // No fallback: the shipped adapter does not silently take over the slot.
  expect(await item(manager, 'open-mercato.telegram')).toMatchObject({ availability: 'failed', management: { enable: false }, record: { enabled: false, error: expect.stringContaining('telegram') } })
  expect(fixture.logs.some(line => line.includes('telegram'))).toBe(true)
})

it('does not run the extension an unreadable selection names', async () => {
  const fixture = await state()
  await edit(fixture.selection, selection => ({ ...selection, revision: 'not-a-uuid' }))
  const manager = fixture.open()
  expect(await item(manager, 'chat.fixture')).toMatchObject({ availability: 'failed', record: { enabled: false } })
  expect((await manager.records()).find(record => record.manifest.id === 'chat.fixture')?.enabled).toBe(false)
  await expect(manager.setEnabled('chat.fixture', true)).rejects.toThrow('unreadable')
})

it('reads an unreadable shipped approval as not enabled and reports it; enabling replaces it', async () => {
  const fixture = await state()
  await edit(fixture.approvals, rows => (rows as Record<string, unknown>[]).map(row => idOf(row) === 'open-mercato.discord' ? breakManifest(row) : row))
  const manager = fixture.open()
  expect(await item(manager, 'open-mercato.discord')).toMatchObject({ availability: 'failed', management: { enable: true }, record: { enabled: false, error: expect.stringContaining('approval') } })
  await manager.startDeliveredChat('discord')
  expect(spawns).not.toHaveBeenCalled()
  expect(fixture.logs.some(line => line.includes('open-mercato.discord'))).toBe(true)
  expect((await item(manager, 'modern.tool'))?.record.enabled).toBe(true)
  await manager.setEnabled('open-mercato.discord', true)
  expect((await manager.approvals.snapshot()).unreadable).toEqual([])
  expect((await item(manager, 'open-mercato.discord'))?.record.enabled).toBe(true)
})

it('reads every shipped adapter as not enabled when the approvals file is unreadable, and refuses to overwrite it', async () => {
  const fixture = await state()
  await writeFile(fixture.approvals, '{')
  const manager = fixture.open()
  for (const id of ['open-mercato.slack', 'open-mercato.discord']) expect((await item(manager, id))?.record.enabled).toBe(false)
  await manager.startDeliveredChat('discord')
  expect(spawns).not.toHaveBeenCalled()
  await expect(manager.approvals.update(records => records)).rejects.toThrow('unreadable')
  expect(await readFile(fixture.approvals, 'utf8')).toBe('{')
})

it('shows an unreadable installed record as failed instead of dropping it', async () => {
  const fixture = await state()
  await edit(fixture.catalog, rows => (rows as Record<string, unknown>[]).map(row => idOf(row) === 'modern.tool' ? breakManifest(row) : row))
  await edit(fixture.approvals, rows => (rows as Record<string, unknown>[]).filter(row => idOf(row) !== 'modern.tool'))
  const manager = fixture.open()
  expect(await item(manager, 'modern.tool')).toMatchObject({ availability: 'failed', management: { enable: false, uninstall: false }, record: { enabled: false, status: 'failed', source: expect.any(String) } })
  expect((await item(manager, 'open-mercato.discord'))?.record.enabled).toBe(true)
})
