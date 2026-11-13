import { SecretStore } from '../workspace/secrets.ts'
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ExtensionHostContext, MAX_KNOWN_SECRETS } from './context.ts'

describe('ExtensionHostContext', () => {
  it('fences permissions, project identity and pending mutations after disable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cezar-extension-context-'))
    const context = new ExtensionHostContext({ secrets: new SecretStore(), dataDir: root, projectId: 'project-a', projectRoot: '/repo/a', extensionId: 'example.test', permissions: ['project.read'] })
    expect(context.projectId).toBe('project-a')
    await expect(context.proposeTask({ title: 'no', prompt: 'no' })).rejects.toThrow('task.create')
    context.disable()
    await expect(context.listTasks()).rejects.toThrow('disabled')
    expect(context.projectRoot).toBe('/repo/a')
  })

  it('isolates extension storage by extension id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cezar-extension-storage-'))
    const one = new ExtensionHostContext({ secrets: new SecretStore(), dataDir: root, projectId: 'p', projectRoot: '/repo', extensionId: 'one', permissions: ['project.read'] })
    const two = new ExtensionHostContext({ secrets: new SecretStore(), dataDir: root, projectId: 'p', projectRoot: '/repo', extensionId: 'two', permissions: ['project.read'] })
    await one.storage.set('answer', 42)
    expect(await two.storage.get('answer')).toBeUndefined()
    expect(await one.storage.get('answer')).toBe(42)
  })
})

it('dispatches only validated operations for its own project and fences a stopped worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-extension-context-'))
  const context = new ExtensionHostContext({ secrets: new SecretStore(), dataDir: root, projectId: 'p', projectRoot: '/repo', extensionId: 'one', permissions: ['project.read'], listTasks: async () => [{ id: 'task', title: 'Title', status: 'running' }] })
  const signal = new AbortController()
  await expect(context.dispatch('tasks.list', {}, signal.signal)).resolves.toHaveLength(1)
  await expect(context.dispatch('storage.set', { key: 'answer', value: 42, projectId: 'other' }, signal.signal)).rejects.toThrow()
  await context.dispatch('storage.set', { key: 'answer', value: 42 }, signal.signal)
  await expect(context.dispatch('storage.get', { key: 'answer' }, signal.signal)).resolves.toBe(42)
  signal.abort()
  await expect(context.dispatch('storage.set', { key: 'answer', value: 43 }, signal.signal)).rejects.toThrow(/disabled|stopped/)
  expect(await context.storage.get('answer')).toBe(42)
})

it('answers tasks.get from the project store under project.read, null for an unknown run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-extension-context-'))
  const tasks = { 'run-1': { id: 'run-1', title: 'Title', status: 'running' as const } }
  const getTask = async (runId: string) => tasks[runId as keyof typeof tasks]
  const signal = new AbortController().signal
  const context = new ExtensionHostContext({ secrets: new SecretStore(), dataDir: root, projectId: 'p', projectRoot: '/repo', extensionId: 'one', permissions: ['project.read'], getTask })
  await expect(context.dispatch('tasks.get', { runId: 'run-1' }, signal)).resolves.toEqual({ id: 'run-1', title: 'Title', status: 'running' })
  await expect(context.dispatch('tasks.get', { runId: 'run-9' }, signal)).resolves.toBeNull()
  // The run id is validated, and a project id in the payload is never consulted (strict input).
  await expect(context.dispatch('tasks.get', { runId: '../x' }, signal)).rejects.toThrow()
  await expect(context.dispatch('tasks.get', { runId: 'run-1', projectId: 'other' }, signal)).rejects.toThrow()
  const unprivileged = new ExtensionHostContext({ secrets: new SecretStore(), dataDir: root, projectId: 'p', projectRoot: '/repo', extensionId: 'two', permissions: [], getTask })
  await expect(unprivileged.dispatch('tasks.get', { runId: 'run-1' }, signal)).rejects.toThrow('project.read')
})

it('fences a storage mutation already queued behind a filesystem lock', async () => {
  const { withLifecycleFileLock } = await import('../worktree-lifecycle/store.ts')
  const root = await mkdtemp(join(tmpdir(), 'cezar-extension-fence-'))
  const context = new ExtensionHostContext({secrets: new SecretStore(), dataDir:root,projectId:'p',projectRoot:root,extensionId:'test',permissions:[]})
  let release!: () => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const locked = withLifecycleFileLock(join(root,'extensions/test/storage.json.lock'), async () => { entered(); await new Promise<void>(resolve => { release = resolve }) })
  await ready
  const mutation = context.dispatch('storage.set',{key:'value',value:'must not commit'},new AbortController().signal)
  const rejection = expect(mutation).rejects.toThrow('disabled')
  context.disable(); release(); await locked; await rejection
  expect(await context.storage.get('value')).toBeUndefined()
})

it('lists only the newest tasks so the reply fits one IPC frame', async () => {
  const { encodeFrame } = await import('./rpc.ts')
  const { MAX_LISTED_TASKS } = await import('./context.ts')
  const root = await mkdtemp(join(tmpdir(), 'cezar-extension-context-'))
  const tasks = Array.from({ length: 20_000 }, (_, index) => ({ id: `task-${index}`.padEnd(200, 'x'), title: 'é"'.repeat(400), status: 'done' as const }))
  const context = new ExtensionHostContext({ secrets: new SecretStore(), dataDir: root, projectId: 'p', projectRoot: '/repo', extensionId: 'one', permissions: ['project.read'], listTasks: async () => tasks })
  const listed = await context.dispatch('tasks.list', {}, new AbortController().signal) as { id: string }[]
  expect(listed).toHaveLength(MAX_LISTED_TASKS)
  expect(listed[0]!.id).toBe(tasks[0]!.id)
  expect(() => encodeFrame({ type: 'hostResponse', requestId: 'r', generation: 'g', ok: true, result: listed })).not.toThrow()
})

it('bounds extension storage by size, keeping what was stored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-extension-storage-'))
  const context = new ExtensionHostContext({ secrets: new SecretStore(), dataDir: root, projectId: 'p', projectRoot: '/repo', extensionId: 'one', permissions: [] })
  const chunk = 'x'.repeat(900 * 1024)
  for (const key of ['a', 'b', 'c', 'd']) await context.storage.set(key, chunk)
  await expect(context.storage.set('e', chunk)).rejects.toThrow('storage is full')
  expect(await context.storage.get('e')).toBeUndefined()
  await context.storage.set('a', 'small')
  await context.storage.set('e', 'fits now')
  expect(await context.storage.get('b')).toBe(chunk)
})

it('bounds extension storage by key count, keeping what was stored', async () => {
  const { MAX_STORAGE_KEYS } = await import('./data.ts')
  const root = await mkdtemp(join(tmpdir(), 'cezar-extension-storage-'))
  const context = new ExtensionHostContext({ secrets: new SecretStore(), dataDir: root, projectId: 'p', projectRoot: '/repo', extensionId: 'one', permissions: [] })
  // Seeded one key short of the cap: a thousand locked rewrites of the file added nothing but 20 s.
  const file = join(root, 'extensions', 'one', 'storage.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(Object.fromEntries(Array.from({ length: MAX_STORAGE_KEYS - 1 }, (_, index) => [`k${index}`, index]))))
  await context.storage.set('last', 1)
  await expect(context.storage.set('one-too-many', 1)).rejects.toThrow('at most')
  expect(await context.storage.get('one-too-many')).toBeUndefined()
  // Rewriting an existing key at the cap adds none.
  await context.storage.set('k0', 'updated')
  expect(await context.storage.get('k0')).toBe('updated')
  expect(await context.storage.get(`k${MAX_STORAGE_KEYS - 2}`)).toBe(MAX_STORAGE_KEYS - 2)
})

it('caps remembered secrets, keeping the ones still in use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-extension-secrets-'))
  const context = new ExtensionHostContext({ secrets: new SecretStore(), dataDir: root, projectId: 'p', projectRoot: '/repo', extensionId: 'one', permissions: [] })
  context.rememberSecret('secret-in-use-0001')
  for (let i = 0; i < MAX_KNOWN_SECRETS * 4; i++) {
    context.rememberSecret(`rotating-secret-${i.toString().padStart(6, '0')}`)
    if (i % 100 === 0) context.rememberSecret('secret-in-use-0001')
  }
  expect((context as unknown as { knownSecrets: Set<string> }).knownSecrets.size).toBe(MAX_KNOWN_SECRETS)
  expect(context.redact('a secret-in-use-0001 b')).toBe('a [REDACTED] b')
  expect(context.redact(`x rotating-secret-${(MAX_KNOWN_SECRETS * 4 - 1).toString().padStart(6, '0')}`)).toBe('x [REDACTED]')
})
